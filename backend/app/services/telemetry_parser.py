from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from math import floor
from typing import Any

from app.core.errors import AppError
from app.db.repository import SQLiteRepository

UNKNOWN_TEAM_ID = "unknown"
PARSE_PROFILE_FULL = "full"
PARSE_PROFILE_HOTSPOT_LIGHT = "hotspot_light"
PARSE_PROFILE_ZONE_ONLY = "zone_only"
PARSE_PROFILES = {PARSE_PROFILE_FULL, PARSE_PROFILE_HOTSPOT_LIGHT, PARSE_PROFILE_ZONE_ONLY}
POSITION_EVENT_TYPES = {"LogPlayerPosition"}
LIFE_EVENT_TYPES = {
    "LogPlayerKill",
    "LogPlayerKillV2",
    "LogPlayerMakeGroggy",
    "LogPlayerRevive",
    "LogPlayerTakeDamage",
}
MATCH_START_EVENT_TYPES = {"LogMatchStart"}


@dataclass(frozen=True)
class TelemetryParseResult:
    event_count: int
    circle_phase_count: int
    team_count: int
    roster_count: int
    position_sample_count: int
    life_event_count: int
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TelemetryTimeline:
    origin_timestamp: float | None

    @classmethod
    def from_events(cls, events: list[dict[str, Any]]) -> TelemetryTimeline:
        first_timestamp: float | None = None
        match_start_timestamp: float | None = None

        for event in events:
            timestamp = _event_timestamp(event)
            if timestamp is None:
                continue
            if first_timestamp is None:
                first_timestamp = timestamp

            explicit_elapsed_time = _explicit_elapsed_time(event)
            if explicit_elapsed_time is not None:
                return cls(origin_timestamp=timestamp - explicit_elapsed_time)

            if match_start_timestamp is None and _event_type(event) in MATCH_START_EVENT_TYPES:
                match_start_timestamp = timestamp

        return cls(origin_timestamp=match_start_timestamp or first_timestamp)

    def elapsed_time(self, event: dict[str, Any]) -> float | None:
        explicit_elapsed_time = _explicit_elapsed_time(event)
        if explicit_elapsed_time is not None:
            return explicit_elapsed_time

        timestamp = _event_timestamp(event)
        if timestamp is None or self.origin_timestamp is None:
            return None
        return max(0.0, round(timestamp - self.origin_timestamp, 3))


@dataclass
class TelemetryParser:
    connection: sqlite3.Connection
    sample_interval_seconds: int = 5
    parse_profile: str = PARSE_PROFILE_FULL

    def __post_init__(self) -> None:
        if self.sample_interval_seconds <= 0:
            raise ValueError("sample_interval_seconds must be greater than zero")
        if self.parse_profile not in PARSE_PROFILES:
            raise ValueError(f"parse_profile must be one of {sorted(PARSE_PROFILES)}")
        self.repo = SQLiteRepository(self.connection)

    def parse_match(self, match_id: str, events: list[dict[str, Any]]) -> TelemetryParseResult:
        if not isinstance(events, list):
            raise AppError(
                code="TELEMETRY_FORMAT_INVALID",
                message="telemetry content must be a JSON array",
                status_code=400,
            )

        warnings: list[str] = []
        events_to_parse = [event for event in events if isinstance(event, dict)]
        if len(events_to_parse) != len(events):
            warnings.append("skipped non-object telemetry events")
        timeline = TelemetryTimeline.from_events(events_to_parse)
        counts = {
            "circle_phase_count": 0,
            "team_count": 0,
            "roster_count": 0,
            "position_sample_count": 0,
            "life_event_count": 0,
        }

        circle_rows = self._circle_rows(match_id, events_to_parse, timeline, warnings)
        for row in circle_rows:
            counts["circle_phase_count"] += self.repo.insert_or_ignore(
                "circle_phases",
                row,
            ).rowcount

        if self.parse_profile == PARSE_PROFILE_ZONE_ONLY:
            self.connection.commit()
            return TelemetryParseResult(event_count=len(events), warnings=warnings, **counts)

        for event in events_to_parse:
            event_type = _event_type(event)
            if event_type in POSITION_EVENT_TYPES:
                self._parse_position_event(match_id, event, timeline, counts, warnings)
            elif event_type in LIFE_EVENT_TYPES:
                self._parse_life_event(match_id, event, timeline, counts, warnings)

        self.connection.commit()
        return TelemetryParseResult(event_count=len(events), warnings=warnings, **counts)

    def _circle_rows(
        self,
        match_id: str,
        events: list[dict[str, Any]],
        timeline: TelemetryTimeline,
        warnings: list[str],
    ) -> list[dict[str, Any]]:
        by_phase: dict[int, dict[str, Any]] = {}
        for event in events:
            if _event_type(event) != "LogGameStatePeriodic":
                continue
            row = self._circle_row(match_id, event, timeline)
            if row is None:
                phase = _phase(event)
                warnings.append(f"skipped incomplete circle phase sample: phase={phase}")
                continue
            by_phase.setdefault(row["phase"], row)
        return [by_phase[phase] for phase in sorted(by_phase)]

    def _circle_row(
        self,
        match_id: str,
        event: dict[str, Any],
        timeline: TelemetryTimeline,
    ) -> dict[str, Any] | None:
        game_state = _dict(event.get("gameState"))
        phase = _phase(event)
        if phase is None:
            return None

        position = _dict(game_state.get("poisonGasWarningPosition"))
        center_x = _number(position.get("x"), position.get("X"))
        center_y = _number(position.get("y"), position.get("Y"))
        radius = _number(game_state.get("poisonGasWarningRadius"))
        elapsed_time = timeline.elapsed_time(event)
        if center_x is None or center_y is None or radius is None or elapsed_time is None:
            return None

        return {
            "match_id": match_id,
            "phase": phase,
            "elapsed_time": elapsed_time,
            "center_x": center_x,
            "center_y": center_y,
            "radius": radius,
            "num_alive_teams": _int_or_none(game_state.get("numAliveTeams")),
            "num_alive_players": _int_or_none(game_state.get("numAlivePlayers")),
        }

    def _parse_position_event(
        self,
        match_id: str,
        event: dict[str, Any],
        timeline: TelemetryTimeline,
        counts: dict[str, int],
        warnings: list[str],
    ) -> None:
        character = _character(event)
        player_id = _player_id(character)
        elapsed_time = timeline.elapsed_time(event)
        location = _location(character) or _location(event)
        if player_id is None or elapsed_time is None or location is None:
            warnings.append("skipped incomplete player position sample")
            return
        if self.parse_profile == PARSE_PROFILE_HOTSPOT_LIGHT and _phase(event) is None:
            warnings.append("skipped player position sample without phase")
            return

        team_id = _team_id(character) or UNKNOWN_TEAM_ID
        counts["team_count"] += self._ensure_team(match_id, team_id, team_id == UNKNOWN_TEAM_ID)
        counts["roster_count"] += self._ensure_roster(
            match_id,
            team_id,
            player_id,
            _player_name(character),
        )
        elapsed_time_bucket = _elapsed_time_bucket(elapsed_time, self.sample_interval_seconds)
        counts["position_sample_count"] += self.repo.insert_or_ignore(
            "player_position_samples",
            {
                "match_id": match_id,
                "player_id": player_id,
                "team_id": team_id,
                "phase": _phase(event),
                "elapsed_time": elapsed_time,
                "elapsed_time_bucket": elapsed_time_bucket,
                "x": location["x"],
                "y": location["y"],
                "z": location.get("z"),
                "alive": _alive(character),
            },
        ).rowcount

    def _parse_life_event(
        self,
        match_id: str,
        event: dict[str, Any],
        timeline: TelemetryTimeline,
        counts: dict[str, int],
        warnings: list[str],
    ) -> None:
        elapsed_time = timeline.elapsed_time(event)
        if elapsed_time is None:
            warnings.append(f"skipped life event without elapsed time: {_event_type(event)}")
            return

        actor = _character(event.get("attacker")) or _character(event.get("killer"))
        victim = _character(event.get("victim")) or _character(event.get("character"))
        for character in (actor, victim):
            if character:
                team_id = _team_id(character) or UNKNOWN_TEAM_ID
                counts["team_count"] += self._ensure_team(
                    match_id,
                    team_id,
                    team_id == UNKNOWN_TEAM_ID,
                )
                player_id = _player_id(character)
                if player_id:
                    counts["roster_count"] += self._ensure_roster(
                        match_id,
                        team_id,
                        player_id,
                        _player_name(character),
                    )

        location = _location(victim or {}) or _location(actor or {}) or _location(event)
        counts["life_event_count"] += self.repo.insert_or_ignore(
            "player_life_events",
            {
                "match_id": match_id,
                "elapsed_time": elapsed_time,
                "phase": _phase(event),
                "event_type": _event_type(event),
                "actor_player_id": _player_id(actor or {}),
                "victim_player_id": _player_id(victim or {}),
                "x": location.get("x") if location else None,
                "y": location.get("y") if location else None,
            },
        ).rowcount

    def _ensure_team(self, match_id: str, team_id: str, is_unknown: bool) -> int:
        return self.repo.insert_or_ignore(
            "match_teams",
            {"match_id": match_id, "team_id": team_id, "is_unknown": int(is_unknown)},
        ).rowcount

    def _ensure_roster(
        self,
        match_id: str,
        team_id: str,
        player_id: str,
        player_name: str | None,
    ) -> int:
        return self.repo.insert_or_ignore(
            "match_rosters",
            {
                "match_id": match_id,
                "team_id": team_id,
                "player_id": player_id,
                "player_name": player_name,
            },
        ).rowcount


def _event_type(event: dict[str, Any]) -> str:
    return str(event.get("_T") or event.get("type") or "")


def _phase(event: dict[str, Any]) -> int | None:
    common = _dict(event.get("common"))
    value = event.get("phase", common.get("isGame"))
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and 1 <= value <= 8:
        return value
    return None


def _explicit_elapsed_time(event: dict[str, Any]) -> float | None:
    common = _dict(event.get("common"))
    game_state = _dict(event.get("gameState"))
    return _number(
        event.get("elapsedTime"),
        common.get("elapsedTime"),
        game_state.get("elapsedTime"),
    )


def _event_timestamp(event: dict[str, Any]) -> float | None:
    value = event.get("_D")
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def _elapsed_time_bucket(elapsed_time: float, sample_interval_seconds: int) -> int:
    return int(floor(elapsed_time / sample_interval_seconds) * sample_interval_seconds)


def _character(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        character = value.get("character")
        if isinstance(character, dict):
            return character
        return value
    return {}


def _player_id(character: dict[str, Any]) -> str | None:
    value = character.get("accountId") or character.get("account_id") or character.get("playerId")
    if value is None:
        value = character.get("name") or character.get("playerName")
    return str(value) if value else None


def _player_name(character: dict[str, Any]) -> str | None:
    value = character.get("name") or character.get("playerName")
    return str(value) if value else None


def _team_id(character: dict[str, Any]) -> str | None:
    value = character.get("teamId") or character.get("team_id")
    return str(value) if value is not None else None


def _location(source: dict[str, Any]) -> dict[str, float] | None:
    location = source.get("location") if isinstance(source, dict) else None
    if not isinstance(location, dict):
        return None
    x = _number(location.get("x"), location.get("X"))
    y = _number(location.get("y"), location.get("Y"))
    z = _number(location.get("z"), location.get("Z"))
    if x is None or y is None:
        return None
    return {"x": x, "y": y, "z": z} if z is not None else {"x": x, "y": y}


def _alive(character: dict[str, Any]) -> int | None:
    alive = character.get("alive")
    if isinstance(alive, bool):
        return int(alive)
    health = _number(character.get("health"))
    return int(health > 0) if health is not None else None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _number(*values: Any) -> float | None:
    for value in values:
        if isinstance(value, bool) or value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
