from __future__ import annotations

import json
import re
import sqlite3
from contextlib import nullcontext
from pathlib import Path

from app.core.errors import AppError
from app.services.player_history import PLATFORM, remote_match
from app.services.pubg_api import PubgApiClient
from app.services.pubg_cache import MASTERY_TTL, MATCH_TTL, SEASON_TTL
from app.services.telemetry_files import file_stamp, load_telemetry

SEASON = re.compile(r"^match\.bro\.(?:official|competitive|ranked)\.(pc-2018-\d+)\.")
KILL_TYPES = {"LogPlayerKill", "LogPlayerKillV2"}


def _member_encounters(events: list[dict], player_ids: list[str]) -> tuple[str | None, dict]:
    by_member: dict[str, dict] = {player_id: {} for player_id in player_ids}
    season = None
    start = next((i for i, e in enumerate(events) if e.get("_T") == "LogMatchStart"), 0)
    for index, event in enumerate(events):
        kind = event.get("_T")
        if kind == "LogMatchDefinition":
            match = SEASON.match(event.get("MatchId") or "")
            if match:
                season = f"division.bro.official.{match[1]}"
        if index < start:
            continue
        if kind == "LogPlayerTakeDamage":
            if (event.get("damage") or 0) <= 0:
                continue
            actor, action = event.get("attacker"), "damage"
        elif kind == "LogPlayerMakeGroggy":
            actor, action = event.get("attacker"), "knock"
        elif kind in KILL_TYPES:
            actor, action = event.get("killer"), "kill"
        else:
            continue
        victim = event.get("victim")
        if not actor or not victim:
            continue
        if (
            actor.get("teamId") is None
            or victim.get("teamId") is None
            or actor["teamId"] == victim["teamId"]
        ):
            continue
        actor_id, victim_id = actor.get("accountId"), victim.get("accountId")
        if actor_id == victim_id:
            continue
        if actor_id in by_member:
            _add_opponent(by_member[actor_id], victim, f"out_{action}")
        if victim_id in by_member:
            _add_opponent(by_member[victim_id], actor, f"in_{action}")
    return season, by_member


def _add_opponent(opponents: dict, other: dict, action: str) -> None:
    other_id = other.get("accountId") or ""
    if not other_id:
        return
    is_bot = other_id.startswith("ai.") or str(other.get("type", "")).lower() in {"ai", "bot"}
    category = "bot" if is_bot else "human" if other_id.startswith("account.") else "unknown"
    opponent = opponents.setdefault(
        other_id,
        {
            "player_id": other_id,
            "name": other.get("name") or other_id,
            "kind": category,
            "actions": [],
        },
    )
    if action not in opponent["actions"]:
        opponent["actions"].append(action)


def extract_encounters(events: list[dict], player_id: str) -> dict:
    season, members = _member_encounters(events, [player_id])
    return {"season": season, "opponents": list(members[player_id].values())}


def match_encounters(
    db: sqlite3.Connection, client: PubgApiClient, cache_dir: Path, match_id: str, player_id: str
) -> dict:
    return _match_members(db, client, cache_dir, match_id, [player_id])[player_id]


def team_encounters(
    db: sqlite3.Connection,
    client: PubgApiClient,
    cache_dir: Path,
    match_id: str,
    player_ids: list[str],
) -> dict:
    match = db.execute(
        """
        SELECT m.game_mode, m.match_type FROM match_rosters r JOIN matches m USING(match_id)
        WHERE r.match_id = ? AND m.shard_id = 'steam' AND r.team_id != 'unknown'
          AND m.game_mode IN ('duo', 'duo-fpp', 'squad', 'squad-fpp')
          AND r.player_id IN (SELECT value FROM json_each(?))
        GROUP BY r.team_id HAVING COUNT(DISTINCT r.player_id) = ?
    """,
        (match_id, json.dumps(player_ids), len(player_ids)),
    ).fetchone()
    if not match:
        raise AppError("NO_SHARED_TEAM", "所选成员未在这场对局中全员同队出场", 400)
    members = _match_members(db, client, cache_dir, match_id, player_ids)
    season = members[player_ids[0]]["season"]
    return {
        "season": season,
        "game_mode": match["game_mode"],
        "match_type": match["match_type"],
        "opponents": {
            member: [other["player_id"] for other in row["opponents"] if other["kind"] == "human"]
            for member, row in members.items()
        },
    }


def _match_members(
    db: sqlite3.Connection,
    client: PubgApiClient,
    cache_dir: Path,
    match_id: str,
    player_ids: list[str],
) -> dict:
    row = db.execute(
        """
        SELECT m.telemetry_url, a.cache_path FROM matches m
        LEFT JOIN telemetry_assets a USING(match_id) WHERE m.match_id=? AND m.shard_id='steam'
    """,
        (match_id,),
    ).fetchone()
    path = cache_dir / f"{match_id}.json"
    if row and row["cache_path"] and Path(row["cache_path"]).is_file():
        path = Path(row["cache_path"])

    def download() -> bytes:
        url = row["telemetry_url"] if row else None
        url = url or remote_match(client, match_id).telemetry_url
        if not url:
            raise AppError("NO_TELEMETRY", "这场对局没有可用遥测", 404)
        return client.download_telemetry(url)

    cache = client.cache
    prefix = f"{PLATFORM}/encounters/v1/{match_id}/"
    lock = cache.match_locks[hash(match_id) % len(cache.match_locks)] if cache else nullcontext()
    with lock:
        stamp = file_stamp(path.stat()) if path.is_file() else None
        found = cache.read(prefix + stamp, player_ids) if cache and stamp else {}
        missing = [pid for pid in player_ids if pid not in found]
        if not missing:
            return found
        _, events, actual_stamp = load_telemetry(path, download)
        if actual_stamp != stamp:
            found = {}
            missing = player_ids
        season, members = _member_encounters([e for e in events if isinstance(e, dict)], missing)
        fetched = {
            pid: {"season": season, "opponents": list(opponents.values())}
            for pid, opponents in members.items()
        }
        if cache:
            cache.write(prefix + actual_stamp, fetched, MATCH_TTL)
        found.update(fetched)
        return found


def summarize_stats(data: dict, ranked: bool) -> dict | None:
    rounds = data.get("roundsPlayed")
    if not rounds:
        return None
    kills = data.get("kills")
    denominator = data.get("deaths" if ranked else "losses")
    damage = data.get("damageDealt")
    tier = data.get("currentTier") or {}
    return {
        "rounds": rounds,
        "kd": round(kills / denominator, 2) if kills is not None and denominator else None,
        "adr": round(damage / rounds, 1) if damage is not None else None,
        "rank": " ".join(str(tier[k]) for k in ("tier", "subTier") if tier.get(k)) or None,
    }


def _season_resource(season: str, mode: str, ranked: bool) -> str:
    # Ranked returns every mode for one player; ordinary stats are batched by mode.
    return f"{PLATFORM}/ranked/{season}" if ranked else f"{PLATFORM}/season/{season}/{mode}"


def season_stats(
    client: PubgApiClient,
    season: str,
    mode: str,
    ranked: bool,
    ids: list[str],
    *,
    cached_only: bool = False,
) -> dict:
    def fetch(missing: list[str]) -> dict:
        try:
            if ranked:
                pid = missing[0]
                response = client.get_ranked_stats(PLATFORM, season, pid)
                modes = response["data"]["attributes"].get("rankedGameModeStats") or {}
                return {
                    pid: {
                        m: summarize_stats(stats, True)
                        for m, stats in modes.items()
                        if stats and stats.get("roundsPlayed")
                    }
                }
            response = client.get_season_batch(PLATFORM, season, mode, missing)
        except AppError as exc:
            if client.cache or exc.details.get("upstream_status") != 404:
                raise
            return {}
        rows = response["data"]
        results = {}
        for row in rows if isinstance(rows, list) else [rows]:
            pid = row["relationships"]["player"]["data"]["id"]
            if pid in missing:
                data = (row["attributes"].get("gameModeStats") or {}).get(mode) or {}
                summary = summarize_stats(data, False)
                results[pid] = {mode: summary} if summary is not None else {}
        return results

    resource = _season_resource(season, mode, ranked)
    if cached_only:
        values = client.cache.read(resource, ids) if client.cache else {}
    elif client.cache:
        values = client.cache.resolve(resource, ids, SEASON_TTL, fetch)
    else:
        values = fetch(ids)
    # A cache-only lookup distinguishes a known absence (null) from a miss (no key).
    return {
        pid: modes.get(mode) if modes else None
        for pid, modes in values.items()
        if cached_only or modes is not None
    }


MASTERY_RESOURCE = f"{PLATFORM}/mastery"


def survival_mastery(client: PubgApiClient, player_id: str) -> dict:
    def fetch(_ids: list[str]) -> dict:
        try:
            payload = client.get_survival_mastery(PLATFORM, player_id)
        except AppError as exc:
            if exc.details.get("upstream_status") != 404:
                raise
            return {}
        attrs = payload["data"]["attributes"]
        level = {"tier": attrs.get("tier"), "level": attrs.get("level")}
        return {player_id: level if any(v is not None for v in level.values()) else None}

    rows = (
        client.cache.resolve(MASTERY_RESOURCE, [player_id], MASTERY_TTL, fetch)
        if client.cache
        else fetch([player_id])
    )
    return rows.get(player_id) or {"tier": None, "level": None}
