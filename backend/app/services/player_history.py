from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from functools import lru_cache

from app.core.errors import AppError
from app.services.pubg_api import (
    PubgApiClient,
    entity_match_refs,
    match_attributes,
    match_telemetry_url,
)
from app.services.pubg_cache import MATCH_TTL

PLATFORM = "steam"
MATCH_TIMEZONE = timezone(timedelta(hours=8))
OFFICIAL_HISTORY_DAYS = 14


@dataclass(frozen=True)
class Match:
    match_id: str
    created_at: str
    map_name: str
    game_mode: str
    match_type: str
    telemetry_url: str | None
    duration: int | None

    def public(self) -> dict:
        values = asdict(self)
        del values["telemetry_url"]
        return values


def remote_match(client: PubgApiClient, match_id: str) -> Match:
    cache = getattr(client, "cache", None)
    if cache is None:
        return _memory_match(client, match_id)
    resource = f"{PLATFORM}/match"
    with cache.match_locks[hash(match_id) % len(cache.match_locks)]:
        row = cache.read(resource, [match_id]).get(match_id)
        if row is not None:
            return Match(**row)
        match = _fetch_match(client, match_id)
        if match.created_at and match.telemetry_url:
            cache.write(resource, {match_id: asdict(match)}, MATCH_TTL)
        return match


@lru_cache(maxsize=512)
def _memory_match(client: PubgApiClient, match_id: str) -> Match:
    return _fetch_match(client, match_id)


def _fetch_match(client: PubgApiClient, match_id: str) -> Match:
    payload = client.get_match(match_id, PLATFORM)
    attrs = match_attributes(payload)
    return Match(
        match_id,
        attrs.get("createdAt") or "",
        attrs.get("mapName") or "",
        attrs.get("gameMode") or "",
        attrs.get("matchType") or "",
        match_telemetry_url(payload),
        attrs.get("duration"),
    )


def _start_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(MATCH_TIMEZONE)


def _on_day(match: Match, day: date) -> bool:
    started = _start_time(match.created_at)
    return started is not None and started.date() == day


def archived_matches(
    db: sqlite3.Connection,
    player_id: str,
    *,
    match_date: date | None = None,
    limit: int = 20,
) -> list[Match]:
    # Narrow the SQL scan before normalizing ISO timestamps with mixed offsets/fractions.
    # Adjacent calendar dates cover both UTC storage and historical offset-form timestamps.
    bounds = (
        """
        AND m.created_at >= COALESCE(date(?, '-1 day'), '')
        AND m.created_at < COALESCE(date(?, '+2 days'), 'Z')
    """
        if match_date
        else ""
    )
    params = (
        (player_id, match_date.isoformat(), match_date.isoformat(), -1)
        if match_date
        else (
            player_id,
            limit,
        )
    )
    rows = db.execute(
        f"""
        SELECT m.match_id, m.created_at, m.map_name, m.game_mode, m.match_type,
               m.telemetry_url, m.duration
        FROM matches m CROSS JOIN match_rosters r USING(match_id)
        WHERE r.player_id = ? AND m.shard_id = 'steam' {bounds}
        ORDER BY m.created_at DESC, m.match_id DESC LIMIT ?
    """,
        params,
    )
    matches = [Match(**dict(row)) for row in rows]
    return [m for m in matches if _on_day(m, match_date)] if match_date else matches


def _ordered(matches: Iterable[Match]) -> list[Match]:
    return sorted(
        matches,
        key=lambda m: (_start_time(m.created_at) or datetime.min.replace(tzinfo=UTC), m.match_id),
        reverse=True,
    )


def recent_matches(
    db: sqlite3.Connection,
    client: PubgApiClient,
    name: str,
    limit: int,
    *,
    match_date: date | None = None,
    refresh: bool = False,
) -> dict:
    warnings = []
    refs = []
    earliest = (datetime.now(UTC) - timedelta(days=OFFICIAL_HISTORY_DAYS)).astimezone(
        MATCH_TIMEZONE
    )
    archive_only = match_date is not None and match_date < earliest.date()
    if archive_only:
        warnings.append("该日期已超出官方近 14 天的可查范围，仅显示已存档对局。")
        if name.startswith("account."):
            matches = archived_matches(db, name, match_date=match_date)
            return {
                "player_id": name,
                "player_name": name,
                "matches": [m.public() for m in _ordered(matches)],
                "warnings": warnings,
            }
    elif match_date == earliest.date():
        warnings.append("该日期部分时段已超出官方历史范围，较早对局依赖本地存档。")
    try:
        if name.startswith("account."):
            player = client.get_player_by_id(PLATFORM, name, refresh=refresh).get("data")
            if not player or player.get("id") != name:
                raise AppError("PLAYER_NOT_FOUND", "未找到这个 Steam 账号", 404)
        else:
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
        refs = entity_match_refs(player)
    except AppError as exc:
        local = db.execute(
            """
            SELECT r.player_id, r.player_name FROM match_rosters r JOIN matches m USING(match_id)
            WHERE (r.player_name = ? COLLATE NOCASE OR r.player_id = ?) AND m.shard_id = 'steam'
              AND r.player_id LIKE 'account.%'
            ORDER BY m.created_at DESC, m.match_id DESC
        """,
            (name, name),
        ).fetchall()
        if len({r["player_id"] for r in local}) != 1:
            if exc.details.get("upstream_status") == 404:
                raise AppError("PLAYER_NOT_FOUND", "未找到这个 Steam 选手", 404) from exc
            raise
        player_id = local[0]["player_id"]
        name = local[0]["player_name"] or player_id
        warnings.append("未能核对官方近期列表，当前显示此玩家已存档的对局。")

    matches = {
        m.match_id: m for m in archived_matches(db, player_id, match_date=match_date, limit=limit)
    }

    def lookup(match_id: str) -> Match | None:
        try:
            return remote_match(client, match_id)
        except AppError:
            return None

    missing = [ref for ref in dict.fromkeys(refs) if ref not in matches]
    if match_date and missing and not archive_only:
        # The player endpoint returns IDs without dates. Prefer stored metadata even
        # for other days so changing the picker does not refetch those match details.
        stored = db.execute(
            """
            SELECT match_id, created_at, map_name, game_mode, match_type, telemetry_url, duration
            FROM matches WHERE shard_id = 'steam' AND created_at IS NOT NULL
                AND match_id IN (SELECT value FROM json_each(?))
        """,
            (json.dumps(missing),),
        )
        known = set()
        for row in stored:
            match = Match(**dict(row))
            if _start_time(match.created_at) is not None:
                known.add(match.match_id)
                if _on_day(match, match_date):
                    matches[match.match_id] = match
        missing = [ref for ref in missing if ref not in known]
    if missing and not archive_only:
        with ThreadPoolExecutor(max_workers=4) as pool:
            found = list(pool.map(lookup, missing))
        failures = found.count(None)
        if failures:
            warnings.append(f"有 {failures} 局未取得比赛时间，未纳入排序。")
        matches.update(
            (m.match_id, m) for m in found if m and (not match_date or _on_day(m, match_date))
        )
    ordered = _ordered(matches.values())
    selected = ordered if match_date else ordered[:limit]
    official_ids = set(refs)
    archived = sum(m.match_id not in official_ids for m in selected)
    if refs and archived and not archive_only:
        warnings.append(f"其中 {archived} 局来自官方近期列表以外的本地存档，期间可能有未存档对局。")
    elif not refs and selected and not warnings:
        warnings.append("官方近期列表为空，结果来自本地存档。")
    return {
        "player_id": player_id,
        "player_name": name,
        "matches": [m.public() for m in selected],
        "warnings": warnings,
    }
