from __future__ import annotations

import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path

from app.core.errors import AppError
from app.services.ingest import IngestService
from app.services.pubg_api import PubgApiClient

PLATFORM = "steam"
SEASON = re.compile(r"^match\.bro\.(?:official|competitive|ranked)\.(pc-2018-\d+)\.")
KILL_TYPES = {"LogPlayerKill", "LogPlayerKillV2"}


@dataclass(frozen=True)
class Match:
    match_id: str
    created_at: str
    map_name: str
    game_mode: str
    match_type: str
    telemetry_url: str | None

    def public(self) -> dict:
        values = asdict(self)
        del values["telemetry_url"]
        return values


@lru_cache(maxsize=512)
def remote_match(client: PubgApiClient, match_id: str) -> Match:
    payload = client.get_match(match_id, PLATFORM)
    attrs = IngestService._match_attributes(payload)
    return Match(
        match_id,
        attrs.get("createdAt") or "",
        attrs.get("mapName") or "",
        attrs.get("gameMode") or "",
        attrs.get("matchType") or "",
        IngestService._telemetry_url(payload),
    )


def recent_matches(db: sqlite3.Connection, client: PubgApiClient, name: str, limit: int) -> dict:
    warnings = []
    refs = []
    try:
        payload = client.get_players_by_names(PLATFORM, [name])
        player = next(
            (
                p
                for p in payload.get("data", [])
                if p["attributes"]["name"].casefold() == name.casefold()
            ),
            None,
        )
        if not player:
            raise AppError("PLAYER_NOT_FOUND", "未找到这个 Steam 选手", 404)
        player_id = player["id"]
        name = player["attributes"]["name"]
        refs = IngestService._match_refs(player)
    except AppError as exc:
        local = db.execute(
            """
            SELECT DISTINCT r.player_id FROM match_rosters r JOIN matches m USING(match_id)
            WHERE r.player_name = ? COLLATE NOCASE AND m.shard_id = 'steam'
              AND r.player_id LIKE 'account.%'
        """,
            (name,),
        ).fetchall()
        if len(local) != 1:
            if exc.details.get("upstream_status") == 404:
                raise AppError("PLAYER_NOT_FOUND", "未找到这个 Steam 选手", 404) from exc
            raise
        player_id = local[0][0]
        warnings.append("未能核对官方近期列表，当前仅包含此昵称在本地存档的对局。")

    rows = db.execute(
        """
        SELECT m.match_id, m.created_at, m.map_name, m.game_mode, m.match_type, m.telemetry_url
        FROM matches m JOIN match_rosters r USING(match_id)
        WHERE r.player_id = ? AND m.shard_id = 'steam'
        ORDER BY m.created_at DESC, m.match_id DESC LIMIT ?
    """,
        (player_id, limit),
    ).fetchall()
    matches = {r["match_id"]: Match(**dict(r)) for r in rows}

    def lookup(match_id: str) -> Match | None:
        try:
            return remote_match(client, match_id)
        except AppError:
            return None

    missing = [ref for ref in dict.fromkeys(refs) if ref not in matches]
    if missing:
        with ThreadPoolExecutor(max_workers=4) as pool:
            found = list(pool.map(lookup, missing))
        failures = found.count(None)
        if failures:
            warnings.append(f"有 {failures} 局未取得比赛时间，未纳入排序。")
        matches.update((m.match_id, m) for m in found if m)
    ordered = sorted(matches.values(), key=lambda m: (m.created_at or "", m.match_id), reverse=True)
    selected = ordered[:limit]
    official_ids = set(refs)
    archived = sum(m.match_id not in official_ids for m in selected)
    if refs and archived:
        warnings.append(f"其中 {archived} 局来自官方近期列表以外的本地存档，期间可能有未存档对局。")
    elif not refs and selected and not warnings:
        warnings.append("官方近期列表为空，结果来自本地存档。")
    return {
        "player_id": player_id,
        "player_name": name,
        "matches": [m.public() for m in selected],
        "warnings": warnings,
    }


def extract_encounters(events: list[dict], player_id: str) -> dict:
    opponents: dict[str, dict] = {}
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
        if (
            not actor
            or not victim
            or player_id not in (actor.get("accountId"), victim.get("accountId"))
        ):
            continue
        if (
            actor.get("teamId") is None
            or victim.get("teamId") is None
            or actor["teamId"] == victim["teamId"]
        ):
            continue
        outgoing = actor.get("accountId") == player_id
        other = victim if outgoing else actor
        other_id = other.get("accountId") or ""
        is_bot = other_id.startswith("ai.") or str(other.get("type", "")).lower() in {"ai", "bot"}
        if not other_id or other_id == player_id:
            continue
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
        label = ("out_" if outgoing else "in_") + action
        if label not in opponent["actions"]:
            opponent["actions"].append(label)
    return {"season": season, "opponents": list(opponents.values())}


def match_encounters(
    db: sqlite3.Connection, client: PubgApiClient, cache_dir: Path, match_id: str, player_id: str
) -> dict:
    row = db.execute(
        """
        SELECT m.telemetry_url, a.cache_path FROM matches m
        LEFT JOIN telemetry_assets a USING(match_id) WHERE m.match_id=? AND m.shard_id='steam'
    """,
        (match_id,),
    ).fetchone()
    paths = [cache_dir / f"{match_id}.json"]
    if row and row["cache_path"]:
        paths.insert(0, Path(row["cache_path"]))
    path = next((p for p in paths if p.is_file()), None)
    if path:
        raw = path.read_bytes()
    else:
        url = row["telemetry_url"] if row else None
        url = url or remote_match(client, match_id).telemetry_url
        if not url:
            raise AppError("NO_TELEMETRY", "这场对局没有可用遥测", 404)
        raw = client.download_telemetry(url)
    try:
        events = json.loads(raw)
    except ValueError as exc:
        raise AppError("INVALID_TELEMETRY", "无法读取对局遥测", 502) from exc
    if not isinstance(events, list) or not events:
        raise AppError("INVALID_TELEMETRY", "缺少对局遥测事件", 502)
    return extract_encounters([e for e in events if isinstance(e, dict)], player_id)


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


def season_stats(
    client: PubgApiClient, season: str, mode: str, ranked: bool, ids: list[str]
) -> dict:
    if ranked:
        payload = client.get_ranked_stats(PLATFORM, season, ids[0])
        data = payload["data"]["attributes"].get("rankedGameModeStats", {})
        return {ids[0]: summarize_stats(data.get(mode) or {}, True)}
    payload = client.get_season_batch(PLATFORM, season, mode, ids)
    rows = payload["data"]
    results = {}
    for row in rows if isinstance(rows, list) else [rows]:
        account = row["relationships"]["player"]["data"]["id"]
        if account in ids:
            stats = row["attributes"].get("gameModeStats", {})
            results[account] = summarize_stats(stats.get(mode) or {}, False)
    return results
