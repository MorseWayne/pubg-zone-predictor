from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote
from uuid import uuid4

from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.pubg_api import PubgApiClient
from app.services.telemetry_parser import (
    PARSE_PROFILE_FULL,
    PARSE_PROFILE_HOTSPOT_LIGHT,
    PARSE_PROFILES,
    TelemetryParser,
)

TERMINAL_JOB_STATUSES = {"completed", "failed", "cancelled"}
DEFAULT_SAMPLE_PLATFORM = "steam"
DEFAULT_SAMPLE_GAME_MODE = "squad"
DEFAULT_SAMPLE_PARSE_PROFILE = PARSE_PROFILE_HOTSPOT_LIGHT
DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS = 30
ANALYSIS_PARSE_PROFILE = PARSE_PROFILE_FULL
ANALYSIS_POSITION_INTERVAL_SECONDS = 5
MAX_TEAM_DASHBOARD_TEAMMATES = 3
TEAMMATE_CANDIDATE_LIMIT = 50
TEAM_DASHBOARD_MATCH_LIMIT = 20
ELIMINATION_EVENT_TYPES = {"LogPlayerKill", "LogPlayerKillV2"}
KNOCKDOWN_EVENT_TYPE = "LogPlayerMakeGroggy"
DAMAGE_EVENT_TYPE = "LogPlayerTakeDamage"
EXCLUDED_SAMPLE_MATCH_TYPES = {"custom", "competitive"}
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IngestJobResult:
    id: str
    job_type: str
    status: str
    source_ref: str | None
    total_count: int
    success_count: int
    skipped_count: int
    failed_count: int
    retry_count: int
    started_at: str | None
    finished_at: str | None
    error_code: str | None
    error_message: str | None
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class IngestMatchAsset:
    match_id: str
    map_name: str
    shard_id: str | None
    game_mode: str | None
    match_type: str | None
    created_at: str | None
    duration: int | None
    ingest_status: str
    telemetry_url: str | None
    telemetry_cache_path: str | None
    telemetry_parse_status: str | None
    telemetry_downloaded_at: str | None
    telemetry_parse_profile: str | None
    telemetry_position_interval_seconds: int | None
    telemetry_parsed_at: str | None
    circle_phase_count: int
    position_sample_count: int
    life_event_count: int


@dataclass(frozen=True)
class MatchAnalysisPlayer:
    player_id: str
    player_name: str | None
    team_id: str
    team_rank: int | None
    is_unknown_team: bool


@dataclass(frozen=True)
class MatchAnalysisCircle:
    phase: int
    elapsed_time: float
    center_x: float
    center_y: float
    radius: float
    num_alive_teams: int | None
    num_alive_players: int | None


@dataclass(frozen=True)
class MatchAnalysisPosition:
    player_id: str
    team_id: str
    phase: int | None
    elapsed_time: float
    x: float
    y: float
    z: float | None
    alive: bool | None


@dataclass(frozen=True)
class MatchAnalysisLifeEvent:
    id: int
    elapsed_time: float
    phase: int | None
    event_type: str
    actor_player_id: str | None
    actor_player_name: str | None
    actor_team_id: str | None
    victim_player_id: str | None
    victim_player_name: str | None
    victim_team_id: str | None
    x: float | None
    y: float | None
    damage: float | None


@dataclass(frozen=True)
class MatchAnalysis:
    match: IngestMatchAsset
    players: list[MatchAnalysisPlayer]
    circles: list[MatchAnalysisCircle]
    positions: list[MatchAnalysisPosition]
    life_events: list[MatchAnalysisLifeEvent]


@dataclass(frozen=True)
class LocalPlayer:
    player_id: str
    player_name: str | None
    match_count: int
    latest_match_at: str | None


@dataclass(frozen=True)
class TeamDashboardPlayer:
    player_id: str
    player_name: str | None
    match_count: int
    wins: int
    top3: int
    avg_rank: float | None
    kills: int
    knocks: int
    deaths: int
    damage: float


@dataclass(frozen=True)
class TeamDashboardMatch:
    match_id: str
    map_name: str
    game_mode: str | None
    created_at: str | None
    duration: int | None
    team_id: str
    team_rank: int | None
    players: list[TeamDashboardPlayer]
    kills: int
    damage: float


@dataclass(frozen=True)
class TeamDashboard:
    primary_player: LocalPlayer
    teammates: list[TeamDashboardPlayer]
    selected_players: list[TeamDashboardPlayer]
    matches: list[TeamDashboardMatch]


@dataclass(frozen=True)
class PersonalTrendMatch:
    match_id: str
    map_name: str
    game_mode: str | None
    created_at: str | None
    team_rank: int | None
    kills: int
    knocks: int
    deaths: int
    damage: float
    score: float


@dataclass(frozen=True)
class PersonalTrendWindow:
    label: str
    match_count: int
    wins: int
    top3: int
    avg_rank: float | None
    kills: int
    knocks: int
    deaths: int
    damage: float
    avg_kills: float
    avg_damage: float
    score: float


@dataclass(frozen=True)
class PersonalTrend:
    primary_player: LocalPlayer
    trend: str
    score_delta: float | None
    damage_delta: float | None
    kills_delta: float | None
    rank_delta: float | None
    early: PersonalTrendWindow
    recent: PersonalTrendWindow
    matches: list[PersonalTrendMatch]


@dataclass(frozen=True)
class DeleteMatchResult:
    match_id: str
    deleted: bool
    telemetry_cache_deleted: bool
    circle_phase_count: int
    position_sample_count: int
    life_event_count: int


@dataclass(frozen=True)
class DeleteJobResult:
    job_id: str
    deleted: bool


@dataclass
class IngestService:
    connection: sqlite3.Connection
    pubg_client: PubgApiClient
    telemetry_cache_dir: Path

    def __post_init__(self) -> None:
        self.repo = SQLiteRepository(self.connection)

    def list_matches(self, *, limit: int = 50) -> list[IngestMatchAsset]:
        rows = self.repo.fetch_all(
            """
            SELECT
                m.match_id,
                m.map_name,
                m.shard_id,
                m.game_mode,
                m.match_type,
                m.created_at,
                m.duration,
                m.ingest_status,
                m.telemetry_url,
                ta.cache_path AS telemetry_cache_path,
                ta.parse_status AS telemetry_parse_status,
                ta.downloaded_at AS telemetry_downloaded_at,
                ta.parse_profile AS telemetry_parse_profile,
                ta.position_interval_seconds AS telemetry_position_interval_seconds,
                ta.parsed_at AS telemetry_parsed_at,
                (
                    SELECT COUNT(*)
                    FROM circle_phases cp
                    WHERE cp.match_id = m.match_id
                ) AS circle_phase_count,
                (
                    SELECT COUNT(*)
                    FROM player_position_samples ps
                    WHERE ps.match_id = m.match_id
                ) AS position_sample_count,
                (
                    SELECT COUNT(*)
                    FROM player_life_events le
                    WHERE le.match_id = m.match_id
                ) AS life_event_count
            FROM matches m
            LEFT JOIN telemetry_assets ta ON ta.match_id = m.match_id
            ORDER BY COALESCE(m.created_at, '') DESC, m.match_id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [self._match_asset(row) for row in rows]

    def list_local_players(self, *, limit: int = 50) -> list[LocalPlayer]:
        rows = self.repo.fetch_all(
            """
            SELECT
                mr.player_id,
                COALESCE(
                    (
                        SELECT mr2.player_name
                        FROM match_rosters mr2
                        JOIN matches m2 ON m2.match_id = mr2.match_id
                        WHERE mr2.player_id = mr.player_id
                            AND mr2.player_name IS NOT NULL
                        ORDER BY COALESCE(m2.created_at, '') DESC, mr2.match_id DESC
                        LIMIT 1
                    ),
                    mr.player_id
                ) AS player_name,
                COUNT(DISTINCT mr.match_id) AS match_count,
                MAX(m.created_at) AS latest_match_at
            FROM match_rosters mr
            JOIN matches m ON m.match_id = mr.match_id
            WHERE mr.player_id != ''
            GROUP BY mr.player_id
            ORDER BY COALESCE(latest_match_at, '') DESC, match_count DESC, mr.player_id
            LIMIT ?
            """,
            (limit,),
        )
        return [self._local_player(row) for row in rows]

    def get_team_dashboard(
        self,
        player_id: str,
        *,
        teammate_ids: list[str] | None = None,
        match_limit: int = TEAM_DASHBOARD_MATCH_LIMIT,
        teammate_candidate_limit: int = TEAMMATE_CANDIDATE_LIMIT,
    ) -> TeamDashboard:
        primary_player = self._get_local_player(player_id)
        teammates = self._team_dashboard_teammates(
            player_id,
            match_limit=teammate_candidate_limit,
        )
        selected_teammate_ids = self._normalize_team_dashboard_teammates(
            teammate_ids,
            player_id,
        )
        if not selected_teammate_ids:
            selected_teammate_ids = [
                teammate.player_id
                for teammate in teammates[:MAX_TEAM_DASHBOARD_TEAMMATES]
            ]
        selected_ids = [player_id, *selected_teammate_ids[:MAX_TEAM_DASHBOARD_TEAMMATES]]
        selected_players = self._team_dashboard_player_stats(
            player_id,
            selected_ids,
            match_limit=match_limit,
            teammate_ids=selected_teammate_ids,
            candidate_limit=teammate_candidate_limit,
        )
        matches = self._team_dashboard_matches(
            player_id,
            selected_ids,
            match_limit=match_limit,
            teammate_ids=selected_teammate_ids,
            candidate_limit=teammate_candidate_limit,
        )
        return TeamDashboard(
            primary_player=primary_player,
            teammates=teammates,
            selected_players=selected_players,
            matches=matches,
        )

    def get_personal_trend(
        self,
        player_id: str,
        *,
        match_limit: int = TEAM_DASHBOARD_MATCH_LIMIT,
    ) -> PersonalTrend:
        primary_player = self._get_local_player(player_id)
        rows = self.repo.fetch_all(
            """
            WITH player_matches AS (
                SELECT m.match_id, m.map_name, m.game_mode, m.created_at, mr.team_id, mt.team_rank
                FROM match_rosters mr
                JOIN matches m ON m.match_id = mr.match_id
                LEFT JOIN match_teams mt
                    ON mt.match_id = mr.match_id
                    AND mt.team_id = mr.team_id
                WHERE mr.player_id = ?
                ORDER BY COALESCE(m.created_at, '') DESC, m.match_id DESC
                LIMIT ?
            ),
            kills AS (
                SELECT match_id, COUNT(*) AS kills
                FROM player_life_events
                WHERE actor_player_id = ?
                    AND event_type IN (?, ?)
                GROUP BY match_id
            ),
            knocks AS (
                SELECT match_id, COUNT(*) AS knocks
                FROM player_life_events
                WHERE actor_player_id = ?
                    AND event_type = ?
                GROUP BY match_id
            ),
            deaths AS (
                SELECT match_id, COUNT(*) AS deaths
                FROM player_life_events
                WHERE victim_player_id = ?
                    AND event_type IN (?, ?)
                GROUP BY match_id
            ),
            damage AS (
                SELECT match_id, SUM(damage) AS damage
                FROM player_life_events
                WHERE actor_player_id = ?
                    AND event_type = ?
                    AND damage IS NOT NULL
                GROUP BY match_id
            )
            SELECT
                pm.match_id,
                pm.map_name,
                pm.game_mode,
                pm.created_at,
                pm.team_rank,
                COALESCE(kills.kills, 0) AS kills,
                COALESCE(knocks.knocks, 0) AS knocks,
                COALESCE(deaths.deaths, 0) AS deaths,
                COALESCE(damage.damage, 0) AS damage
            FROM player_matches pm
            LEFT JOIN kills ON kills.match_id = pm.match_id
            LEFT JOIN knocks ON knocks.match_id = pm.match_id
            LEFT JOIN deaths ON deaths.match_id = pm.match_id
            LEFT JOIN damage ON damage.match_id = pm.match_id
            ORDER BY COALESCE(pm.created_at, '') DESC, pm.match_id DESC
            """,
            (
                player_id,
                match_limit,
                player_id,
                *sorted(ELIMINATION_EVENT_TYPES),
                player_id,
                KNOCKDOWN_EVENT_TYPE,
                player_id,
                *sorted(ELIMINATION_EVENT_TYPES),
                player_id,
                DAMAGE_EVENT_TYPE,
            ),
        )
        matches = [self._personal_trend_match(row) for row in rows]
        chronological = list(reversed(matches))
        split_at = len(chronological) // 2
        early = self._personal_trend_window("早期样本", chronological[:split_at])
        recent = self._personal_trend_window("最近样本", chronological[split_at:])
        enough_data = early.match_count > 0 and recent.match_count > 0 and len(matches) >= 4
        score_delta = recent.score - early.score if enough_data else None
        damage_delta = recent.avg_damage - early.avg_damage if enough_data else None
        kills_delta = recent.avg_kills - early.avg_kills if enough_data else None
        rank_delta = (
            recent.avg_rank - early.avg_rank
            if enough_data and recent.avg_rank is not None and early.avg_rank is not None
            else None
        )
        threshold = max(25.0, abs(early.score) * 0.1)
        if not enough_data or score_delta is None:
            trend = "insufficient_data"
        elif score_delta >= threshold:
            trend = "improving"
        elif score_delta <= -threshold:
            trend = "declining"
        else:
            trend = "stable"
        return PersonalTrend(
            primary_player=primary_player,
            trend=trend,
            score_delta=score_delta,
            damage_delta=damage_delta,
            kills_delta=kills_delta,
            rank_delta=rank_delta,
            early=early,
            recent=recent,
            matches=matches,
        )

    def _team_dashboard_teammates(
        self,
        player_id: str,
        *,
        match_limit: int,
    ) -> list[TeamDashboardPlayer]:
        rows = self.repo.fetch_all(
            """
            WITH primary_matches AS (
                SELECT m.match_id, mr.team_id, m.created_at
                FROM match_rosters mr
                JOIN matches m ON m.match_id = mr.match_id
                WHERE mr.player_id = ?
                    AND m.game_mode IN ('squad', 'squad-fpp')
                ORDER BY COALESCE(m.created_at, '') DESC, m.match_id DESC
                LIMIT ?
            )
            SELECT tr.player_id
            FROM primary_matches pm
            JOIN match_rosters tr
                ON tr.match_id = pm.match_id
                AND tr.team_id = pm.team_id
            WHERE tr.player_id != ?
            GROUP BY tr.player_id
            ORDER BY COUNT(*) DESC, COALESCE(MAX(pm.created_at), '') DESC, tr.player_id
            LIMIT ?
            """,
            (
                player_id,
                match_limit,
                player_id,
                match_limit,
            ),
        )
        teammate_ids = [row["player_id"] for row in rows]
        stats = self._team_dashboard_player_stats(
            player_id,
            teammate_ids,
            match_limit=match_limit,
            teammate_ids=[],
            candidate_limit=match_limit,
        )
        by_id = {player.player_id: player for player in stats}
        return [by_id[player_id] for player_id in teammate_ids if player_id in by_id]

    def _team_dashboard_player_stats(
        self,
        player_id: str,
        player_ids: list[str],
        *,
        match_limit: int,
        teammate_ids: list[str],
        candidate_limit: int,
    ) -> list[TeamDashboardPlayer]:
        if not player_ids:
            return []
        placeholders = ", ".join("?" for _ in player_ids)
        teammate_placeholders = ", ".join("?" for _ in teammate_ids)
        teammate_filter = (
            f"""
                WHERE EXISTS (
                    SELECT 1
                    FROM match_rosters selected_teammate
                    WHERE selected_teammate.match_id = primary_matches.match_id
                        AND selected_teammate.team_id = primary_matches.team_id
                        AND selected_teammate.player_id IN ({teammate_placeholders})
                )
            """
            if teammate_ids
            else ""
        )
        rows = self.repo.fetch_all(
            f"""
            WITH primary_matches AS (
                SELECT m.match_id, mr.team_id, m.created_at
                FROM match_rosters mr
                JOIN matches m ON m.match_id = mr.match_id
                WHERE mr.player_id = ?
                    AND m.game_mode IN ('squad', 'squad-fpp')
                ORDER BY COALESCE(m.created_at, '') DESC, m.match_id DESC
                LIMIT ?
            ),
            stat_matches AS (
                SELECT primary_matches.match_id, primary_matches.team_id
                FROM primary_matches
                {teammate_filter}
                ORDER BY
                    COALESCE(primary_matches.created_at, '') DESC,
                    primary_matches.match_id DESC
                LIMIT ?
            ),
            kills AS (
                SELECT match_id, actor_player_id AS player_id, COUNT(*) AS kills
                FROM player_life_events
                WHERE event_type IN (?, ?)
                GROUP BY match_id, actor_player_id
            ),
            knocks AS (
                SELECT match_id, actor_player_id AS player_id, COUNT(*) AS knocks
                FROM player_life_events
                WHERE event_type = ?
                GROUP BY match_id, actor_player_id
            ),
            deaths AS (
                SELECT match_id, victim_player_id AS player_id, COUNT(*) AS deaths
                FROM player_life_events
                WHERE event_type IN (?, ?)
                GROUP BY match_id, victim_player_id
            ),
            damage AS (
                SELECT match_id, actor_player_id AS player_id, SUM(damage) AS damage
                FROM player_life_events
                WHERE event_type = ?
                    AND damage IS NOT NULL
                GROUP BY match_id, actor_player_id
            )
            SELECT
                tr.player_id,
                COALESCE(MAX(tr.player_name), tr.player_id) AS player_name,
                COUNT(DISTINCT tr.match_id) AS match_count,
                SUM(CASE WHEN mt.team_rank = 1 THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN mt.team_rank <= 3 THEN 1 ELSE 0 END) AS top3,
                AVG(mt.team_rank) AS avg_rank,
                COALESCE(SUM(kills.kills), 0) AS kills,
                COALESCE(SUM(knocks.knocks), 0) AS knocks,
                COALESCE(SUM(deaths.deaths), 0) AS deaths,
                COALESCE(SUM(damage.damage), 0) AS damage
            FROM stat_matches pm
            JOIN match_rosters tr
                ON tr.match_id = pm.match_id
                AND tr.team_id = pm.team_id
            LEFT JOIN match_teams mt
                ON mt.match_id = pm.match_id
                AND mt.team_id = pm.team_id
            LEFT JOIN kills
                ON kills.match_id = tr.match_id
                AND kills.player_id = tr.player_id
            LEFT JOIN knocks
                ON knocks.match_id = tr.match_id
                AND knocks.player_id = tr.player_id
            LEFT JOIN deaths
                ON deaths.match_id = tr.match_id
                AND deaths.player_id = tr.player_id
            LEFT JOIN damage
                ON damage.match_id = tr.match_id
                AND damage.player_id = tr.player_id
            WHERE tr.player_id IN ({placeholders})
            GROUP BY tr.player_id
            """,
            (
                player_id,
                candidate_limit,
                *teammate_ids,
                match_limit,
                *sorted(ELIMINATION_EVENT_TYPES),
                KNOCKDOWN_EVENT_TYPE,
                *sorted(ELIMINATION_EVENT_TYPES),
                DAMAGE_EVENT_TYPE,
                *player_ids,
            ),
        )
        by_id = {row["player_id"]: self._dashboard_player(row) for row in rows}
        return [
            by_id.get(next_player_id) or self._empty_dashboard_player(next_player_id)
            for next_player_id in player_ids
        ]

    def _team_dashboard_matches(
        self,
        player_id: str,
        player_ids: list[str],
        *,
        match_limit: int,
        teammate_ids: list[str],
        candidate_limit: int,
    ) -> list[TeamDashboardMatch]:
        if not player_ids:
            return []
        placeholders = ", ".join("?" for _ in player_ids)
        teammate_placeholders = ", ".join("?" for _ in teammate_ids)
        teammate_filter = (
            f"""
                WHERE EXISTS (
                    SELECT 1
                    FROM match_rosters selected_teammate
                    WHERE selected_teammate.match_id = primary_matches.match_id
                        AND selected_teammate.team_id = primary_matches.team_id
                        AND selected_teammate.player_id IN ({teammate_placeholders})
                )
            """
            if teammate_ids
            else ""
        )
        rows = self.repo.fetch_all(
            f"""
            WITH primary_matches AS (
                SELECT m.match_id, mr.team_id, m.created_at
                FROM match_rosters mr
                JOIN matches m ON m.match_id = mr.match_id
                WHERE mr.player_id = ?
                    AND m.game_mode IN ('squad', 'squad-fpp')
                ORDER BY COALESCE(m.created_at, '') DESC, m.match_id DESC
                LIMIT ?
            ),
            stat_matches AS (
                SELECT primary_matches.match_id, primary_matches.team_id
                FROM primary_matches
                {teammate_filter}
                ORDER BY
                    COALESCE(primary_matches.created_at, '') DESC,
                    primary_matches.match_id DESC
                LIMIT ?
            ),
            kills AS (
                SELECT match_id, actor_player_id AS player_id, COUNT(*) AS kills
                FROM player_life_events
                WHERE event_type IN (?, ?)
                GROUP BY match_id, actor_player_id
            ),
            knocks AS (
                SELECT match_id, actor_player_id AS player_id, COUNT(*) AS knocks
                FROM player_life_events
                WHERE event_type = ?
                GROUP BY match_id, actor_player_id
            ),
            deaths AS (
                SELECT match_id, victim_player_id AS player_id, COUNT(*) AS deaths
                FROM player_life_events
                WHERE event_type IN (?, ?)
                GROUP BY match_id, victim_player_id
            ),
            damage AS (
                SELECT match_id, actor_player_id AS player_id, SUM(damage) AS damage
                FROM player_life_events
                WHERE event_type = ?
                    AND damage IS NOT NULL
                GROUP BY match_id, actor_player_id
            )
            SELECT
                m.match_id,
                m.map_name,
                m.game_mode,
                m.created_at,
                m.duration,
                pm.team_id,
                mt.team_rank,
                tr.player_id,
                tr.player_name,
                COALESCE(kills.kills, 0) AS kills,
                COALESCE(knocks.knocks, 0) AS knocks,
                COALESCE(deaths.deaths, 0) AS deaths,
                COALESCE(damage.damage, 0) AS damage
            FROM stat_matches pm
            JOIN matches m ON m.match_id = pm.match_id
            LEFT JOIN match_teams mt
                ON mt.match_id = pm.match_id
                AND mt.team_id = pm.team_id
            JOIN match_rosters tr
                ON tr.match_id = pm.match_id
                AND tr.team_id = pm.team_id
            LEFT JOIN kills
                ON kills.match_id = tr.match_id
                AND kills.player_id = tr.player_id
            LEFT JOIN knocks
                ON knocks.match_id = tr.match_id
                AND knocks.player_id = tr.player_id
            LEFT JOIN deaths
                ON deaths.match_id = tr.match_id
                AND deaths.player_id = tr.player_id
            LEFT JOIN damage
                ON damage.match_id = tr.match_id
                AND damage.player_id = tr.player_id
            WHERE tr.player_id IN ({placeholders})
            ORDER BY COALESCE(m.created_at, '') DESC, m.match_id DESC, tr.player_id
            """,
            (
                player_id,
                candidate_limit,
                *teammate_ids,
                match_limit,
                *sorted(ELIMINATION_EVENT_TYPES),
                KNOCKDOWN_EVENT_TYPE,
                *sorted(ELIMINATION_EVENT_TYPES),
                DAMAGE_EVENT_TYPE,
                *player_ids,
            ),
        )
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            match_id = row["match_id"]
            if match_id not in grouped:
                grouped[match_id] = {
                    "map_name": row["map_name"],
                    "game_mode": row["game_mode"],
                    "created_at": row["created_at"],
                    "duration": row["duration"],
                    "team_id": row["team_id"],
                    "team_rank": row["team_rank"],
                    "players": [],
                }
            team_rank = row["team_rank"]
            grouped[match_id]["players"].append(
                TeamDashboardPlayer(
                    player_id=row["player_id"],
                    player_name=row["player_name"] or row["player_id"],
                    match_count=1,
                    wins=1 if team_rank == 1 else 0,
                    top3=1 if team_rank is not None and team_rank <= 3 else 0,
                    avg_rank=float(team_rank) if team_rank is not None else None,
                    kills=int(row["kills"]),
                    knocks=int(row["knocks"]),
                    deaths=int(row["deaths"]),
                    damage=float(row["damage"]),
                )
            )
        matches = []
        for match_id, data in grouped.items():
            players = data["players"]
            matches.append(
                TeamDashboardMatch(
                    match_id=match_id,
                    map_name=data["map_name"],
                    game_mode=data["game_mode"],
                    created_at=data["created_at"],
                    duration=data["duration"],
                    team_id=data["team_id"],
                    team_rank=data["team_rank"],
                    players=players,
                    kills=sum(player.kills for player in players),
                    damage=sum(player.damage for player in players),
                )
            )
        return matches

    def _get_local_player(self, player_id: str) -> LocalPlayer:
        row = self.repo.fetch_one(
            """
            SELECT
                mr.player_id,
                COALESCE(MAX(mr.player_name), mr.player_id) AS player_name,
                COUNT(DISTINCT mr.match_id) AS match_count,
                MAX(m.created_at) AS latest_match_at
            FROM match_rosters mr
            JOIN matches m ON m.match_id = mr.match_id
            WHERE mr.player_id = ?
            GROUP BY mr.player_id
            """,
            (player_id,),
        )
        if row is None:
            raise AppError(
                code="INGEST_PLAYER_NOT_FOUND",
                message=f"player '{player_id}' was not found in local match data",
                status_code=404,
                details={"player_id": player_id},
            )
        return self._local_player(row)

    def _empty_dashboard_player(self, player_id: str) -> TeamDashboardPlayer:
        row = self.repo.fetch_one(
            """
            SELECT COALESCE(MAX(player_name), ?) AS player_name
            FROM match_rosters
            WHERE player_id = ?
            """,
            (player_id, player_id),
        )
        return TeamDashboardPlayer(
            player_id=player_id,
            player_name=row["player_name"] if row else player_id,
            match_count=0,
            wins=0,
            top3=0,
            avg_rank=None,
            kills=0,
            knocks=0,
            deaths=0,
            damage=0.0,
        )

    @staticmethod
    def _normalize_team_dashboard_teammates(
        teammate_ids: list[str] | None,
        primary_player_id: str,
    ) -> list[str]:
        selected: list[str] = []
        for player_id in teammate_ids or []:
            value = player_id.strip()
            if not value or value == primary_player_id or value in selected:
                continue
            selected.append(value)
        return selected[:MAX_TEAM_DASHBOARD_TEAMMATES]

    def get_match_analysis(self, match_id: str) -> MatchAnalysis:
        self._ensure_match_analysis_data(match_id)
        match = self._get_match_asset(match_id)
        player_rows = self.repo.fetch_all(
            """
            SELECT
                mr.player_id,
                mr.player_name,
                mr.team_id,
                mt.team_rank,
                mt.is_unknown
            FROM match_rosters mr
            LEFT JOIN match_teams mt
                ON mt.match_id = mr.match_id
                AND mt.team_id = mr.team_id
            WHERE mr.match_id = ?
            ORDER BY COALESCE(mt.team_rank, 999), mr.team_id, COALESCE(mr.player_name, mr.player_id)
            """,
            (match_id,),
        )
        circle_rows = self.repo.fetch_all(
            """
            SELECT
                phase,
                elapsed_time,
                center_x,
                center_y,
                radius,
                num_alive_teams,
                num_alive_players
            FROM circle_phases
            WHERE match_id = ?
            ORDER BY phase ASC
            """,
            (match_id,),
        )
        position_rows = self.repo.fetch_all(
            """
            SELECT
                player_id,
                team_id,
                phase,
                elapsed_time,
                x,
                y,
                z,
                alive
            FROM player_position_samples
            WHERE match_id = ?
            ORDER BY elapsed_time ASC, player_id ASC
            """,
            (match_id,),
        )
        life_event_rows = self.repo.fetch_all(
            """
            SELECT
                le.id,
                le.elapsed_time,
                le.phase,
                le.event_type,
                le.actor_player_id,
                actor.player_name AS actor_player_name,
                actor.team_id AS actor_team_id,
                le.victim_player_id,
                victim.player_name AS victim_player_name,
                victim.team_id AS victim_team_id,
                le.x,
                le.y,
                le.damage
            FROM player_life_events le
            LEFT JOIN match_rosters actor
                ON actor.match_id = le.match_id
                AND actor.player_id = le.actor_player_id
            LEFT JOIN match_rosters victim
                ON victim.match_id = le.match_id
                AND victim.player_id = le.victim_player_id
            WHERE le.match_id = ?
            ORDER BY le.elapsed_time ASC, le.id ASC
            """,
            (match_id,),
        )
        return MatchAnalysis(
            match=match,
            players=[self._analysis_player(row) for row in player_rows],
            circles=[self._analysis_circle(row) for row in circle_rows],
            positions=[self._analysis_position(row) for row in position_rows],
            life_events=[self._analysis_life_event(row) for row in life_event_rows],
        )

    def _ensure_match_analysis_data(self, match_id: str) -> None:
        match = self._get_match_asset(match_id)
        has_analysis_data = self._has_match_analysis_data(match)
        needs_damage_backfill = has_analysis_data and self._has_missing_life_event_damage(match_id)
        if has_analysis_data and not needs_damage_backfill:
            return

        cache_path = (
            self._existing_match_telemetry_cache(match)
            if needs_damage_backfill
            else self._ensure_match_telemetry_cache(match)
        )
        if cache_path is None:
            return
        try:
            parse_result = self._parse_cached_match_telemetry(
                match_id,
                cache_path,
                parse_profile=ANALYSIS_PARSE_PROFILE,
                position_interval_seconds=ANALYSIS_POSITION_INTERVAL_SECONDS,
            )
        except AppError as exc:
            self.repo.execute(
                """
                UPDATE telemetry_assets
                SET parse_status = 'failed',
                    error_message = ?
                WHERE match_id = ?
                """,
                (exc.message, match_id),
            )
            self.connection.commit()
            raise
        _log_parse_warnings(match_id, parse_result.warnings)

    def _has_missing_life_event_damage(self, match_id: str) -> bool:
        row = self.repo.fetch_one(
            """
            SELECT 1
            FROM player_life_events
            WHERE match_id = ?
                AND event_type = 'LogPlayerTakeDamage'
                AND damage IS NULL
            LIMIT 1
            """,
            (match_id,),
        )
        return row is not None

    @staticmethod
    def _existing_match_telemetry_cache(match: IngestMatchAsset) -> Path | None:
        if not match.telemetry_cache_path:
            return None
        cache_path = Path(match.telemetry_cache_path)
        return cache_path if cache_path.exists() else None

    def _ensure_match_telemetry_cache(self, match: IngestMatchAsset) -> Path:
        if match.telemetry_cache_path:
            cache_path = Path(match.telemetry_cache_path)
            if cache_path.exists():
                return cache_path

        telemetry_url = self._ensure_match_telemetry_url(match)
        return self._cache_match_telemetry(match.match_id, telemetry_url)

    def _ensure_match_telemetry_url(self, match: IngestMatchAsset) -> str:
        if match.telemetry_url:
            return match.telemetry_url

        asset = self.repo.fetch_one(
            "SELECT telemetry_url FROM telemetry_assets WHERE match_id = ?",
            (match.match_id,),
        )
        if asset is not None and asset["telemetry_url"]:
            return asset["telemetry_url"]

        platform = match.shard_id or DEFAULT_SAMPLE_PLATFORM
        if platform == "tournament":
            payload = self.pubg_client.get_tournament_match(match.match_id)
        else:
            payload = self.pubg_client.get_match(match.match_id, platform)

        current = self.repo.fetch_one(
            "SELECT tournament_id FROM matches WHERE match_id = ?",
            (match.match_id,),
        )
        tournament_id = current["tournament_id"] if current else None
        match_values, telemetry_url = self._match_values(match.match_id, tournament_id, payload)
        self.repo.upsert("matches", match_values, conflict_columns=("match_id",))
        if telemetry_url:
            return telemetry_url

        raise AppError(
            code="TELEMETRY_URL_NOT_FOUND",
            message=f"telemetry URL is not known for match '{match.match_id}'",
            status_code=404,
            details={"match_id": match.match_id},
        )

    @staticmethod
    def _has_match_analysis_data(match: IngestMatchAsset) -> bool:
        return (
            match.telemetry_parse_status == "completed"
            and match.telemetry_parse_profile == ANALYSIS_PARSE_PROFILE
            and match.telemetry_position_interval_seconds == ANALYSIS_POSITION_INTERVAL_SECONDS
            and match.circle_phase_count > 0
            and (match.position_sample_count > 0 or match.life_event_count > 0)
        )

    def list_jobs(self, *, limit: int = 20) -> list[IngestJobResult]:
        rows = self.repo.fetch_all(
            """
            SELECT *
            FROM ingest_jobs
            ORDER BY COALESCE(started_at, '') DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [self._job_result(row) for row in rows]

    def delete_match(self, match_id: str) -> DeleteMatchResult:
        match = self.repo.fetch_one(
            """
            SELECT
                ta.cache_path AS telemetry_cache_path,
                (SELECT COUNT(*) FROM circle_phases WHERE match_id = ?) AS circle_phase_count,
                (
                    SELECT COUNT(*)
                    FROM player_position_samples
                    WHERE match_id = ?
                ) AS position_sample_count,
                (SELECT COUNT(*) FROM player_life_events WHERE match_id = ?) AS life_event_count
            FROM matches m
            LEFT JOIN telemetry_assets ta ON ta.match_id = m.match_id
            WHERE m.match_id = ?
            """,
            (match_id, match_id, match_id, match_id),
        )
        if match is None:
            raise AppError(
                code="INGEST_MATCH_NOT_FOUND",
                message=f"match '{match_id}' was not found",
                status_code=404,
                details={"match_id": match_id},
            )

        telemetry_cache_deleted = False
        cache_path_value = match["telemetry_cache_path"]
        if cache_path_value:
            cache_path = Path(cache_path_value)
            if cache_path.exists() and cache_path.is_file():
                cache_path.unlink()
                telemetry_cache_deleted = True

        self.repo.execute("DELETE FROM matches WHERE match_id = ?", (match_id,))
        self.connection.commit()
        return DeleteMatchResult(
            match_id=match_id,
            deleted=True,
            telemetry_cache_deleted=telemetry_cache_deleted,
            circle_phase_count=int(match["circle_phase_count"]),
            position_sample_count=int(match["position_sample_count"]),
            life_event_count=int(match["life_event_count"]),
        )

    def delete_matches(self, match_ids: list[str]) -> list[DeleteMatchResult]:
        results: list[DeleteMatchResult] = []
        for match_id in dict.fromkeys(match_ids):
            results.append(self.delete_match(match_id))
        return results

    def ingest_tournaments(self, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("tournament_list", "pubg-api", retry_count=retry_count)
        try:
            payload = self.pubg_client.get_tournaments()
            tournaments = self._data_list(payload)
            stats = _empty_stats(total_count=len(tournaments))
            warnings: list[str] = []

            for tournament in tournaments:
                tournament_id = tournament.get("id")
                if not tournament_id:
                    stats["skipped_count"] += 1
                    warnings.append("skipped tournament without id")
                    continue
                attributes = self._attributes(tournament)
                self.repo.upsert(
                    "tournaments",
                    {
                        "id": tournament_id,
                        "type": tournament.get("type", "tournament"),
                        "created_at": attributes.get("createdAt"),
                        "source": "pubg_api",
                    },
                    conflict_columns=("id",),
                )
                stats["success_count"] += 1

            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def ingest_tournament(self, tournament_id: str, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("tournament_matches", tournament_id, retry_count=retry_count)
        warnings: list[str] = []
        try:
            payload = self.pubg_client.get_tournament(tournament_id)
            tournament = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
            attributes = self._attributes(tournament)
            self.repo.upsert(
                "tournaments",
                {
                    "id": tournament_id,
                    "type": tournament.get("type", "tournament"),
                    "created_at": attributes.get("createdAt"),
                    "source": "pubg_api",
                },
                conflict_columns=("id",),
            )

            match_refs = self._match_refs(tournament)
            stats = _empty_stats(total_count=len(match_refs))
            for match_id in match_refs:
                try:
                    match_payload = self.pubg_client.get_tournament_match(match_id)
                    match_values, telemetry_url = self._match_values(
                        match_id,
                        tournament_id,
                        match_payload,
                    )
                    self.repo.upsert("matches", match_values, conflict_columns=("match_id",))
                    if not telemetry_url:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' has no telemetry URL")
                        continue

                    cache_path = self._cache_match_telemetry(match_id, telemetry_url)
                    parse_result = self._parse_cached_match_telemetry(match_id, cache_path)
                    _log_parse_warnings(match_id, parse_result.warnings)
                    stats["success_count"] += 1
                except AppError as exc:
                    stats["failed_count"] += 1
                    warnings.append(f"match '{match_id}' failed: {exc.message}")

            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def ingest_sample_matches(
        self,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        retry_count: int = 0,
    ) -> IngestJobResult:
        job = self.start_sample_matches(
            platform=platform,
            game_mode=game_mode,
            max_matches=max_matches,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
            retry_count=retry_count,
        )
        self.run_sample_matches_job(
            job.id,
            platform=platform,
            game_mode=game_mode,
            max_matches=max_matches,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
        )
        return self.get_job(job.id)

    def ingest_player_matches(
        self,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        player_names: list[str],
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches_per_player: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        retry_count: int = 0,
    ) -> IngestJobResult:
        job = self.start_player_matches(
            platform=platform,
            player_names=player_names,
            game_mode=game_mode,
            max_matches_per_player=max_matches_per_player,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
            retry_count=retry_count,
        )
        self.run_player_matches_job(
            job.id,
            platform=platform,
            player_names=player_names,
            game_mode=game_mode,
            max_matches_per_player=max_matches_per_player,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
        )
        return self.get_job(job.id)

    def start_sample_matches(
        self,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        retry_count: int = 0,
    ) -> IngestJobResult:
        _validate_parse_options(parse_profile, position_interval_seconds)
        source_ref = _sample_source_ref(
            platform,
            game_mode,
            max_matches=max_matches,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
        )
        job_id = self._create_job("sample_matches", source_ref, retry_count=retry_count)
        return IngestJobResult(
            id=job_id,
            job_type="sample_matches",
            status="running",
            source_ref=source_ref,
            total_count=0,
            success_count=0,
            skipped_count=0,
            failed_count=0,
            retry_count=retry_count,
            started_at=_utc_now(),
            finished_at=None,
            error_code=None,
            error_message=None,
            warnings=[],
        )

    def start_player_matches(
        self,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        player_names: list[str],
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches_per_player: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        retry_count: int = 0,
    ) -> IngestJobResult:
        _validate_parse_options(parse_profile, position_interval_seconds)
        normalized_names = _normalize_player_names(player_names)
        source_ref = _player_source_ref(
            platform,
            game_mode,
            normalized_names,
            max_matches_per_player=max_matches_per_player,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
        )
        job_id = self._create_job("player_matches", source_ref, retry_count=retry_count)
        return IngestJobResult(
            id=job_id,
            job_type="player_matches",
            status="running",
            source_ref=source_ref,
            total_count=0,
            success_count=0,
            skipped_count=0,
            failed_count=0,
            retry_count=retry_count,
            started_at=_utc_now(),
            finished_at=None,
            error_code=None,
            error_message=None,
            warnings=[],
        )

    def run_sample_matches_job(
        self,
        job_id: str,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
    ) -> None:
        _validate_parse_options(parse_profile, position_interval_seconds)
        warnings: list[str] = []
        try:
            payload = self.pubg_client.get_match_samples(platform)
            match_refs = self._sample_match_refs(payload)
            if max_matches is not None:
                match_refs = match_refs[:max_matches]
            stats = _empty_stats(total_count=len(match_refs))
            self._update_job_progress(job_id, stats, warnings=warnings)
            cancelled = False

            for match_id in match_refs:
                if self._is_job_cancelled(job_id):
                    return
                try:
                    match_payload = self.pubg_client.get_match(match_id, platform)
                    match_values, telemetry_url = self._match_values(
                        match_id,
                        None,
                        match_payload,
                    )
                    attributes = self._match_attributes(match_payload)
                    match_game_mode = attributes.get("gameMode")
                    match_type = attributes.get("matchType")
                    if match_game_mode != game_mode:
                        stats["skipped_count"] += 1
                        warnings.append(
                            f"match '{match_id}' skipped: gameMode is '{match_game_mode}'"
                        )
                        continue
                    if isinstance(match_type, str) and match_type in EXCLUDED_SAMPLE_MATCH_TYPES:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' skipped: matchType is '{match_type}'")
                        continue

                    self.repo.upsert("matches", match_values, conflict_columns=("match_id",))
                    if not telemetry_url:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' has no telemetry URL")
                        continue

                    cache_path = self._cache_match_telemetry(match_id, telemetry_url)
                    parse_result = self._parse_cached_match_telemetry(
                        match_id,
                        cache_path,
                        parse_profile=parse_profile,
                        position_interval_seconds=position_interval_seconds,
                    )
                    _log_parse_warnings(match_id, parse_result.warnings)
                    stats["success_count"] += 1
                except AppError as exc:
                    stats["failed_count"] += 1
                    warnings.append(f"match '{match_id}' failed: {exc.message}")
                finally:
                    self._update_job_progress(job_id, stats, warnings=warnings)
                    cancelled = self._is_job_cancelled(job_id)
                if cancelled:
                    break

            if cancelled or self._is_job_cancelled(job_id):
                return
            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)

    def run_player_matches_job(
        self,
        job_id: str,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        player_names: list[str],
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches_per_player: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
    ) -> None:
        _validate_parse_options(parse_profile, position_interval_seconds)
        warnings: list[str] = []
        try:
            normalized_names = _normalize_player_names(player_names)
            payload = self.pubg_client.get_players_by_names(platform, normalized_names)
            match_refs = self._player_match_refs(
                payload,
                max_matches_per_player=max_matches_per_player,
            )
            stats = _empty_stats(total_count=len(match_refs))
            self._update_job_progress(job_id, stats, warnings=warnings)
            cancelled = False

            for match_id in match_refs:
                if self._is_job_cancelled(job_id):
                    return
                try:
                    match_payload = self.pubg_client.get_match(match_id, platform)
                    match_values, telemetry_url = self._match_values(
                        match_id,
                        None,
                        match_payload,
                    )
                    attributes = self._match_attributes(match_payload)
                    match_game_mode = attributes.get("gameMode")
                    match_type = attributes.get("matchType")
                    if match_game_mode != game_mode:
                        stats["skipped_count"] += 1
                        warnings.append(
                            f"match '{match_id}' skipped: gameMode is '{match_game_mode}'"
                        )
                        continue
                    if isinstance(match_type, str) and match_type in EXCLUDED_SAMPLE_MATCH_TYPES:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' skipped: matchType is '{match_type}'")
                        continue

                    self.repo.upsert("matches", match_values, conflict_columns=("match_id",))
                    if not telemetry_url:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' has no telemetry URL")
                        continue

                    cache_path = self._cache_match_telemetry(match_id, telemetry_url)
                    parse_result = self._parse_cached_match_telemetry(
                        match_id,
                        cache_path,
                        parse_profile=parse_profile,
                        position_interval_seconds=position_interval_seconds,
                    )
                    _log_parse_warnings(match_id, parse_result.warnings)
                    stats["success_count"] += 1
                except AppError as exc:
                    stats["failed_count"] += 1
                    warnings.append(f"match '{match_id}' failed: {exc.message}")
                finally:
                    self._update_job_progress(job_id, stats, warnings=warnings)
                    cancelled = self._is_job_cancelled(job_id)
                if cancelled:
                    break

            if cancelled or self._is_job_cancelled(job_id):
                return
            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)

    def download_match_telemetry(self, match_id: str, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("telemetry_download", match_id, retry_count=retry_count)
        try:
            asset = self.repo.fetch_one(
                "SELECT telemetry_url FROM telemetry_assets WHERE match_id = ?",
                (match_id,),
            )
            if asset is None:
                raise AppError(
                    code="TELEMETRY_ASSET_NOT_FOUND",
                    message=f"telemetry URL is not known for match '{match_id}'",
                    status_code=404,
                    details={"match_id": match_id},
                )

            self._cache_match_telemetry(match_id, asset["telemetry_url"])
            self._complete_job(
                job_id,
                {"total_count": 1, "success_count": 1, "skipped_count": 0, "failed_count": 0},
            )
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def parse_match_telemetry(self, match_id: str, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("telemetry_parse", match_id, retry_count=retry_count)
        try:
            asset = self.repo.fetch_one(
                "SELECT cache_path FROM telemetry_assets WHERE match_id = ?",
                (match_id,),
            )
            if asset is None or not asset["cache_path"]:
                raise AppError(
                    code="TELEMETRY_CACHE_NOT_FOUND",
                    message=f"telemetry cache is not known for match '{match_id}'",
                    status_code=404,
                    details={"match_id": match_id},
                )

            cache_path = Path(asset["cache_path"])
            if not cache_path.exists():
                raise AppError(
                    code="TELEMETRY_CACHE_NOT_FOUND",
                    message=f"telemetry cache file was not found for match '{match_id}'",
                    status_code=404,
                    details={"match_id": match_id, "cache_path": str(cache_path)},
                )

            parse_result = self._parse_cached_match_telemetry(match_id, cache_path)
            _log_parse_warnings(match_id, parse_result.warnings)
            parsed_count = self._parsed_row_count(match_id)
            self._complete_job(
                job_id,
                {
                    "total_count": parse_result.event_count,
                    "success_count": parsed_count,
                    "skipped_count": len(parse_result.warnings),
                    "failed_count": 0,
                },
            )
        except AppError as exc:
            self.repo.execute(
                """
                UPDATE telemetry_assets
                SET parse_status = 'failed',
                    error_message = ?
                WHERE match_id = ?
                """,
                (exc.message, match_id),
            )
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def _cache_match_telemetry(self, match_id: str, telemetry_url: str) -> Path:
        content = self.pubg_client.download_telemetry(telemetry_url)
        content_hash = hashlib.sha256(content).hexdigest()
        cache_path = self.telemetry_cache_dir / f"{match_id}.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(content)
        self.repo.upsert(
            "telemetry_assets",
            {
                "match_id": match_id,
                "telemetry_url": telemetry_url,
                "cache_path": str(cache_path),
                "content_hash": content_hash,
                "downloaded_at": _utc_now(),
                "parse_status": "pending",
                "parse_profile": None,
                "position_interval_seconds": None,
                "parsed_at": None,
                "error_message": None,
            },
            conflict_columns=("match_id",),
        )
        return cache_path

    def _parse_cached_match_telemetry(
        self,
        match_id: str,
        cache_path: Path,
        *,
        parse_profile: str = PARSE_PROFILE_FULL,
        position_interval_seconds: int = 5,
    ) -> Any:
        events = _read_telemetry_events(cache_path)
        parse_result = TelemetryParser(
            self.connection,
            sample_interval_seconds=position_interval_seconds,
            parse_profile=parse_profile,
        ).parse_match(match_id, events)
        self.repo.execute(
            """
            UPDATE telemetry_assets
            SET parse_status = 'completed',
                error_message = ?,
                parse_profile = ?,
                position_interval_seconds = ?,
                parsed_at = ?
            WHERE match_id = ?
            """,
            (
                json.dumps(parse_result.warnings, ensure_ascii=False)
                if parse_result.warnings
                else None,
                parse_profile,
                position_interval_seconds,
                _utc_now(),
                match_id,
            ),
        )
        return parse_result

    def _parsed_row_count(self, match_id: str) -> int:
        row = self.repo.fetch_one(
            """
            SELECT
                (SELECT COUNT(*) FROM circle_phases WHERE match_id = ?) +
                (SELECT COUNT(*) FROM player_position_samples WHERE match_id = ?) +
                (SELECT COUNT(*) FROM player_life_events WHERE match_id = ?) AS count
            """,
            (match_id, match_id, match_id),
        )
        return int(row["count"] if row else 0)

    def get_job(self, job_id: str) -> IngestJobResult:
        row = self.repo.fetch_one("SELECT * FROM ingest_jobs WHERE id = ?", (job_id,))
        if row is None:
            raise AppError(
                code="INGEST_JOB_NOT_FOUND",
                message=f"ingest job '{job_id}' was not found",
                status_code=404,
                details={"job_id": job_id},
            )
        return self._job_result(row)

    def retry_job(self, job_id: str) -> IngestJobResult:
        job = self.get_job(job_id)
        next_retry_count = job.retry_count + 1
        if job.job_type == "tournament_list":
            return self.ingest_tournaments(retry_count=next_retry_count)
        if job.job_type == "tournament_matches" and job.source_ref:
            return self.ingest_tournament(job.source_ref, retry_count=next_retry_count)
        if job.job_type == "sample_matches" and job.source_ref:
            platform, game_mode, max_matches, parse_profile, position_interval_seconds = (
                _sample_source_ref_parts(job.source_ref)
            )
            return self.ingest_sample_matches(
                platform=platform,
                game_mode=game_mode,
                max_matches=max_matches,
                parse_profile=parse_profile,
                position_interval_seconds=position_interval_seconds,
                retry_count=next_retry_count,
            )
        if job.job_type == "player_matches" and job.source_ref:
            (
                platform,
                game_mode,
                player_names,
                max_matches_per_player,
                parse_profile,
                position_interval_seconds,
            ) = _player_source_ref_parts(job.source_ref)
            return self.ingest_player_matches(
                platform=platform,
                player_names=player_names,
                game_mode=game_mode,
                max_matches_per_player=max_matches_per_player,
                parse_profile=parse_profile,
                position_interval_seconds=position_interval_seconds,
                retry_count=next_retry_count,
            )
        if job.job_type == "telemetry_download" and job.source_ref:
            return self.download_match_telemetry(job.source_ref, retry_count=next_retry_count)
        if job.job_type == "telemetry_parse" and job.source_ref:
            return self.parse_match_telemetry(job.source_ref, retry_count=next_retry_count)
        raise AppError(
            code="INGEST_JOB_NOT_RETRYABLE",
            message=f"ingest job '{job_id}' cannot be retried",
            details={"job_id": job_id, "job_type": job.job_type},
        )

    def retry_jobs(self, job_ids: list[str]) -> list[IngestJobResult]:
        return [self.retry_job(job_id) for job_id in job_ids]

    def cancel_job(self, job_id: str) -> IngestJobResult:
        job = self.get_job(job_id)
        if job.status in TERMINAL_JOB_STATUSES:
            return job
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'cancelled',
                finished_at = ?,
                error_code = NULL,
                error_message = NULL
            WHERE id = ? AND status = 'running'
            """,
            (_utc_now(), job_id),
        )
        self.connection.commit()
        return self.get_job(job_id)

    def cancel_jobs(self, job_ids: list[str]) -> list[IngestJobResult]:
        return [self.cancel_job(job_id) for job_id in job_ids]

    def delete_job(self, job_id: str) -> DeleteJobResult:
        job = self.get_job(job_id)
        if job.status not in TERMINAL_JOB_STATUSES:
            raise AppError(
                code="INGEST_JOB_RUNNING",
                message=f"ingest job '{job_id}' is still running; cancel it before deleting it",
                status_code=409,
                details={"job_id": job_id, "status": job.status},
            )
        self.repo.execute("DELETE FROM ingest_jobs WHERE id = ?", (job_id,))
        self.connection.commit()
        return DeleteJobResult(job_id=job_id, deleted=True)

    def delete_jobs(self, job_ids: list[str]) -> list[DeleteJobResult]:
        return [self.delete_job(job_id) for job_id in job_ids]

    def _create_job(self, job_type: str, source_ref: str | None, *, retry_count: int = 0) -> str:
        job_id = f"job_{uuid4().hex}"
        started_at = _utc_now()
        try:
            self.repo.execute(
                """
                INSERT INTO ingest_jobs (
                    id,
                    job_type,
                    status,
                    source_ref,
                    retry_count,
                    started_at
                )
                VALUES (?, ?, 'running', ?, ?, ?)
                """,
                (job_id, job_type, source_ref, retry_count, started_at),
            )
        except sqlite3.IntegrityError as exc:
            raise AppError(
                code="INGEST_JOB_CREATE_FAILED",
                message=(
                    f"failed to create ingest job of type '{job_type}'. "
                    "Run database migrations and try again."
                ),
                status_code=500,
                details={"job_type": job_type, "source_ref": source_ref},
            ) from exc
        self.connection.commit()
        return job_id

    def _complete_job(
        self,
        job_id: str,
        stats: dict[str, int],
        *,
        warnings: list[str] | None = None,
    ) -> None:
        error_message = json.dumps(warnings, ensure_ascii=False) if warnings else None
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'completed',
                total_count = ?,
                success_count = ?,
                skipped_count = ?,
                failed_count = ?,
                finished_at = ?,
                error_code = NULL,
                error_message = ?
            WHERE id = ? AND status = 'running'
            """,
            (
                stats["total_count"],
                stats["success_count"],
                stats["skipped_count"],
                stats["failed_count"],
                _utc_now(),
                error_message,
                job_id,
            ),
        )
        self.connection.commit()

    def _update_job_progress(
        self,
        job_id: str,
        stats: dict[str, int],
        *,
        warnings: list[str] | None = None,
    ) -> None:
        error_message = json.dumps(warnings, ensure_ascii=False) if warnings else None
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'running',
                total_count = ?,
                success_count = ?,
                skipped_count = ?,
                failed_count = ?,
                error_message = ?
            WHERE id = ? AND status = 'running'
            """,
            (
                stats["total_count"],
                stats["success_count"],
                stats["skipped_count"],
                stats["failed_count"],
                error_message,
                job_id,
            ),
        )
        self.connection.commit()

    def _fail_job(self, job_id: str, error_code: str, error_message: str) -> None:
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'failed',
                failed_count = CASE WHEN total_count = 0 THEN 1 ELSE failed_count END,
                finished_at = ?,
                error_code = ?,
                error_message = ?
            WHERE id = ? AND status = 'running'
            """,
            (_utc_now(), error_code, error_message, job_id),
        )
        self.connection.commit()

    def _is_job_cancelled(self, job_id: str) -> bool:
        row = self.repo.fetch_one("SELECT status FROM ingest_jobs WHERE id = ?", (job_id,))
        return bool(row and row["status"] == "cancelled")

    @staticmethod
    def _data_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
        data = payload.get("data", [])
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    @staticmethod
    def _attributes(entity: dict[str, Any]) -> dict[str, Any]:
        attributes = entity.get("attributes", {})
        return attributes if isinstance(attributes, dict) else {}

    @staticmethod
    def _match_refs(tournament: dict[str, Any]) -> list[str]:
        relationships = tournament.get("relationships", {})
        matches = relationships.get("matches", {}) if isinstance(relationships, dict) else {}
        data = matches.get("data", []) if isinstance(matches, dict) else []
        return [item["id"] for item in data if isinstance(item, dict) and item.get("id")]

    @staticmethod
    def _sample_match_refs(payload: dict[str, Any]) -> list[str]:
        data = payload.get("data", {})
        sample_items = data if isinstance(data, list) else [data]
        match_ids: list[str] = []
        for sample in sample_items:
            if not isinstance(sample, dict):
                continue
            relationships = sample.get("relationships", {})
            matches = relationships.get("matches", {}) if isinstance(relationships, dict) else {}
            refs = matches.get("data", []) if isinstance(matches, dict) else []
            match_ids.extend(
                item["id"] for item in refs if isinstance(item, dict) and item.get("id")
            )
        return match_ids

    @staticmethod
    def _player_match_refs(
        payload: dict[str, Any],
        *,
        max_matches_per_player: int | None = None,
    ) -> list[str]:
        players = IngestService._data_list(payload)
        seen: set[str] = set()
        match_ids: list[str] = []
        for player in players:
            refs = IngestService._match_refs(player)
            if max_matches_per_player is not None:
                refs = refs[:max_matches_per_player]
            for match_id in refs:
                if match_id in seen:
                    continue
                seen.add(match_id)
                match_ids.append(match_id)
        return match_ids

    @staticmethod
    def _match_values(
        match_id: str,
        tournament_id: str | None,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], str | None]:
        match = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
        attributes = IngestService._match_attributes(payload)
        telemetry_url = IngestService._telemetry_url(payload)
        return (
            {
                "match_id": match.get("id", match_id),
                "tournament_id": tournament_id,
                "map_name": attributes.get("mapName") or "unknown",
                "shard_id": attributes.get("shardId"),
                "game_mode": attributes.get("gameMode"),
                "match_type": attributes.get("matchType"),
                "created_at": attributes.get("createdAt"),
                "duration": attributes.get("duration"),
                "telemetry_url": telemetry_url,
                "ingest_status": "completed" if telemetry_url else "skipped",
                "error_message": None if telemetry_url else "telemetry URL missing",
            },
            telemetry_url,
        )

    @staticmethod
    def _match_attributes(payload: dict[str, Any]) -> dict[str, Any]:
        match = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
        return IngestService._attributes(match)

    @staticmethod
    def _telemetry_url(payload: dict[str, Any]) -> str | None:
        included = payload.get("included", [])
        if not isinstance(included, list):
            return None
        for entity in included:
            if not isinstance(entity, dict):
                continue
            attributes = entity.get("attributes", {})
            if isinstance(attributes, dict) and attributes.get("URL"):
                return attributes["URL"]
        return None

    @staticmethod
    def _local_player(row: sqlite3.Row) -> LocalPlayer:
        return LocalPlayer(
            player_id=row["player_id"],
            player_name=row["player_name"],
            match_count=int(row["match_count"]),
            latest_match_at=row["latest_match_at"],
        )

    @staticmethod
    def _dashboard_player(row: sqlite3.Row) -> TeamDashboardPlayer:
        avg_rank = row["avg_rank"]
        return TeamDashboardPlayer(
            player_id=row["player_id"],
            player_name=row["player_name"],
            match_count=int(row["match_count"]),
            wins=int(row["wins"]),
            top3=int(row["top3"]),
            avg_rank=float(avg_rank) if avg_rank is not None else None,
            kills=int(row["kills"]),
            knocks=int(row["knocks"]),
            deaths=int(row["deaths"]),
            damage=float(row["damage"]),
        )

    @staticmethod
    def _personal_trend_match(row: sqlite3.Row) -> PersonalTrendMatch:
        kills = int(row["kills"])
        damage = float(row["damage"])
        team_rank = row["team_rank"]
        deaths = int(row["deaths"])
        score = damage + kills * 75 - deaths * 25
        # ponytail: simple trend score; tune weights or replace with a model when labels exist.
        if team_rank is not None:
            score += max(0, 25 - int(team_rank)) * 8
        return PersonalTrendMatch(
            match_id=row["match_id"],
            map_name=row["map_name"],
            game_mode=row["game_mode"],
            created_at=row["created_at"],
            team_rank=team_rank,
            kills=kills,
            knocks=int(row["knocks"]),
            deaths=deaths,
            damage=damage,
            score=score,
        )

    @staticmethod
    def _personal_trend_window(
        label: str,
        matches: list[PersonalTrendMatch],
    ) -> PersonalTrendWindow:
        match_count = len(matches)
        wins = sum(1 for match in matches if match.team_rank == 1)
        top3 = sum(1 for match in matches if match.team_rank is not None and match.team_rank <= 3)
        kills = sum(match.kills for match in matches)
        knocks = sum(match.knocks for match in matches)
        deaths = sum(match.deaths for match in matches)
        damage = sum(match.damage for match in matches)
        ranked = [match.team_rank for match in matches if match.team_rank is not None]
        return PersonalTrendWindow(
            label=label,
            match_count=match_count,
            wins=wins,
            top3=top3,
            avg_rank=sum(ranked) / len(ranked) if ranked else None,
            kills=kills,
            knocks=knocks,
            deaths=deaths,
            damage=damage,
            avg_kills=kills / match_count if match_count else 0.0,
            avg_damage=damage / match_count if match_count else 0.0,
            score=sum(match.score for match in matches) / match_count if match_count else 0.0,
        )

    @staticmethod
    def _match_asset(row: sqlite3.Row) -> IngestMatchAsset:
        return IngestMatchAsset(
            match_id=row["match_id"],
            map_name=row["map_name"],
            shard_id=row["shard_id"],
            game_mode=row["game_mode"],
            match_type=row["match_type"],
            created_at=row["created_at"],
            duration=row["duration"],
            ingest_status=row["ingest_status"],
            telemetry_url=row["telemetry_url"],
            telemetry_cache_path=row["telemetry_cache_path"],
            telemetry_parse_status=row["telemetry_parse_status"],
            telemetry_downloaded_at=row["telemetry_downloaded_at"],
            telemetry_parse_profile=row["telemetry_parse_profile"],
            telemetry_position_interval_seconds=(
                int(row["telemetry_position_interval_seconds"])
                if row["telemetry_position_interval_seconds"] is not None
                else None
            ),
            telemetry_parsed_at=row["telemetry_parsed_at"],
            circle_phase_count=int(row["circle_phase_count"]),
            position_sample_count=int(row["position_sample_count"]),
            life_event_count=int(row["life_event_count"]),
        )

    def _get_match_asset(self, match_id: str) -> IngestMatchAsset:
        row = self.repo.fetch_one(
            """
            SELECT
                m.match_id,
                m.map_name,
                m.shard_id,
                m.game_mode,
                m.match_type,
                m.created_at,
                m.duration,
                m.ingest_status,
                m.telemetry_url,
                ta.cache_path AS telemetry_cache_path,
                ta.parse_status AS telemetry_parse_status,
                ta.downloaded_at AS telemetry_downloaded_at,
                ta.parse_profile AS telemetry_parse_profile,
                ta.position_interval_seconds AS telemetry_position_interval_seconds,
                ta.parsed_at AS telemetry_parsed_at,
                (
                    SELECT COUNT(*)
                    FROM circle_phases cp
                    WHERE cp.match_id = m.match_id
                ) AS circle_phase_count,
                (
                    SELECT COUNT(*)
                    FROM player_position_samples ps
                    WHERE ps.match_id = m.match_id
                ) AS position_sample_count,
                (
                    SELECT COUNT(*)
                    FROM player_life_events le
                    WHERE le.match_id = m.match_id
                ) AS life_event_count
            FROM matches m
            LEFT JOIN telemetry_assets ta ON ta.match_id = m.match_id
            WHERE m.match_id = ?
            """,
            (match_id,),
        )
        if row is None:
            raise AppError(
                code="INGEST_MATCH_NOT_FOUND",
                message=f"match '{match_id}' was not found",
                status_code=404,
                details={"match_id": match_id},
            )
        return self._match_asset(row)

    @staticmethod
    def _analysis_player(row: sqlite3.Row) -> MatchAnalysisPlayer:
        return MatchAnalysisPlayer(
            player_id=row["player_id"],
            player_name=row["player_name"],
            team_id=row["team_id"],
            team_rank=row["team_rank"],
            is_unknown_team=bool(row["is_unknown"]),
        )

    @staticmethod
    def _analysis_circle(row: sqlite3.Row) -> MatchAnalysisCircle:
        return MatchAnalysisCircle(
            phase=int(row["phase"]),
            elapsed_time=float(row["elapsed_time"]),
            center_x=float(row["center_x"]),
            center_y=float(row["center_y"]),
            radius=float(row["radius"]),
            num_alive_teams=row["num_alive_teams"],
            num_alive_players=row["num_alive_players"],
        )

    @staticmethod
    def _analysis_position(row: sqlite3.Row) -> MatchAnalysisPosition:
        alive = row["alive"]
        return MatchAnalysisPosition(
            player_id=row["player_id"],
            team_id=row["team_id"],
            phase=row["phase"],
            elapsed_time=float(row["elapsed_time"]),
            x=float(row["x"]),
            y=float(row["y"]),
            z=float(row["z"]) if row["z"] is not None else None,
            alive=bool(alive) if alive is not None else None,
        )

    @staticmethod
    def _analysis_life_event(row: sqlite3.Row) -> MatchAnalysisLifeEvent:
        return MatchAnalysisLifeEvent(
            id=int(row["id"]),
            elapsed_time=float(row["elapsed_time"]),
            phase=row["phase"],
            event_type=row["event_type"],
            actor_player_id=row["actor_player_id"],
            actor_player_name=row["actor_player_name"],
            actor_team_id=row["actor_team_id"],
            victim_player_id=row["victim_player_id"],
            victim_player_name=row["victim_player_name"],
            victim_team_id=row["victim_team_id"],
            x=float(row["x"]) if row["x"] is not None else None,
            y=float(row["y"]) if row["y"] is not None else None,
            damage=float(row["damage"]) if row["damage"] is not None else None,
        )

    @staticmethod
    def _job_result(row: sqlite3.Row) -> IngestJobResult:
        warnings: list[str] = []
        if row["status"] != "failed" and row["error_message"]:
            try:
                decoded = json.loads(row["error_message"])
                warnings = decoded if isinstance(decoded, list) else [str(decoded)]
            except json.JSONDecodeError:
                warnings = [row["error_message"]]
        return IngestJobResult(
            id=row["id"],
            job_type=row["job_type"],
            status=row["status"],
            source_ref=row["source_ref"],
            total_count=row["total_count"],
            success_count=row["success_count"],
            skipped_count=row["skipped_count"],
            failed_count=row["failed_count"],
            retry_count=row["retry_count"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            error_code=row["error_code"],
            error_message=row["error_message"] if row["status"] == "failed" else None,
            warnings=warnings,
        )


def _read_telemetry_events(cache_path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AppError(
            code="TELEMETRY_CACHE_INVALID",
            message="telemetry cache file is not valid JSON",
            status_code=400,
            details={"cache_path": str(cache_path)},
        ) from exc
    if not isinstance(payload, list):
        raise AppError(
            code="TELEMETRY_FORMAT_INVALID",
            message="telemetry content must be a JSON array",
            status_code=400,
            details={"cache_path": str(cache_path)},
        )
    return payload


def _sample_source_ref(
    platform: str,
    game_mode: str,
    *,
    max_matches: int | None = None,
    parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
    position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
) -> str:
    parts = [f"samples:{platform}:{game_mode}"]
    if max_matches is not None:
        parts.append(f"max={max_matches}")
    parts.append(f"profile={parse_profile}")
    parts.append(f"interval={position_interval_seconds}")
    return ":".join(parts)


def _sample_source_ref_parts(source_ref: str) -> tuple[str, str, int | None, str, int]:
    parts = source_ref.split(":")
    if len(parts) < 3 or parts[0] != "samples" or not parts[1] or not parts[2]:
        raise AppError(
            code="INGEST_JOB_SOURCE_REF_INVALID",
            message=f"sample ingest job source_ref '{source_ref}' is invalid",
            details={"source_ref": source_ref},
        )
    max_matches: int | None = None
    parse_profile = DEFAULT_SAMPLE_PARSE_PROFILE
    position_interval_seconds = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS
    for option in parts[3:]:
        key, _, value = option.partition("=")
        if not key or not value:
            raise AppError(
                code="INGEST_JOB_SOURCE_REF_INVALID",
                message=f"sample ingest job source_ref '{source_ref}' is invalid",
                details={"source_ref": source_ref},
            )
        if key == "max":
            try:
                max_matches = int(value)
            except ValueError as exc:
                raise AppError(
                    code="INGEST_JOB_SOURCE_REF_INVALID",
                    message=f"sample ingest job source_ref '{source_ref}' is invalid",
                    details={"source_ref": source_ref},
                ) from exc
        elif key == "profile":
            parse_profile = value
        elif key == "interval":
            try:
                position_interval_seconds = int(value)
            except ValueError as exc:
                raise AppError(
                    code="INGEST_JOB_SOURCE_REF_INVALID",
                    message=f"sample ingest job source_ref '{source_ref}' is invalid",
                    details={"source_ref": source_ref},
                ) from exc
        else:
            raise AppError(
                code="INGEST_JOB_SOURCE_REF_INVALID",
                message=f"sample ingest job source_ref '{source_ref}' is invalid",
                details={"source_ref": source_ref},
            )
    _validate_parse_options(parse_profile, position_interval_seconds)
    return parts[1], parts[2], max_matches, parse_profile, position_interval_seconds


def _player_source_ref(
    platform: str,
    game_mode: str,
    player_names: list[str],
    *,
    max_matches_per_player: int | None = None,
    parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
    position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
) -> str:
    encoded_names = ",".join(quote(name, safe="") for name in _normalize_player_names(player_names))
    parts = [f"players:{platform}:{game_mode}", f"names={encoded_names}"]
    if max_matches_per_player is not None:
        parts.append(f"max={max_matches_per_player}")
    parts.append(f"profile={parse_profile}")
    parts.append(f"interval={position_interval_seconds}")
    return ":".join(parts)


def _player_source_ref_parts(source_ref: str) -> tuple[str, str, list[str], int | None, str, int]:
    parts = source_ref.split(":")
    if len(parts) < 4 or parts[0] != "players" or not parts[1] or not parts[2]:
        raise AppError(
            code="INGEST_JOB_SOURCE_REF_INVALID",
            message=f"player ingest job source_ref '{source_ref}' is invalid",
            details={"source_ref": source_ref},
        )
    names: list[str] | None = None
    max_matches_per_player: int | None = None
    parse_profile = DEFAULT_SAMPLE_PARSE_PROFILE
    position_interval_seconds = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS
    for option in parts[3:]:
        key, _, value = option.partition("=")
        if not key or not value:
            raise AppError(
                code="INGEST_JOB_SOURCE_REF_INVALID",
                message=f"player ingest job source_ref '{source_ref}' is invalid",
                details={"source_ref": source_ref},
            )
        if key == "names":
            names = [unquote(item) for item in value.split(",") if item]
        elif key == "max":
            try:
                max_matches_per_player = int(value)
            except ValueError as exc:
                raise AppError(
                    code="INGEST_JOB_SOURCE_REF_INVALID",
                    message=f"player ingest job source_ref '{source_ref}' is invalid",
                    details={"source_ref": source_ref},
                ) from exc
        elif key == "profile":
            parse_profile = value
        elif key == "interval":
            try:
                position_interval_seconds = int(value)
            except ValueError as exc:
                raise AppError(
                    code="INGEST_JOB_SOURCE_REF_INVALID",
                    message=f"player ingest job source_ref '{source_ref}' is invalid",
                    details={"source_ref": source_ref},
                ) from exc
        else:
            raise AppError(
                code="INGEST_JOB_SOURCE_REF_INVALID",
                message=f"player ingest job source_ref '{source_ref}' is invalid",
                details={"source_ref": source_ref},
            )
    if names is None:
        raise AppError(
            code="INGEST_JOB_SOURCE_REF_INVALID",
            message=f"player ingest job source_ref '{source_ref}' is invalid",
            details={"source_ref": source_ref},
        )
    _validate_parse_options(parse_profile, position_interval_seconds)
    return (
        parts[1],
        parts[2],
        _normalize_player_names(names),
        max_matches_per_player,
        parse_profile,
        position_interval_seconds,
    )


def _normalize_player_names(player_names: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for name in player_names:
        value = name.strip()
        key = value.lower()
        if not value or key in seen:
            continue
        seen.add(key)
        normalized.append(value)
    if not normalized:
        raise AppError(
            code="INGEST_PLAYER_NAMES_REQUIRED",
            message="at least one player name is required",
            status_code=400,
        )
    if len(normalized) > 10:
        raise AppError(
            code="INGEST_PLAYER_NAMES_LIMIT_EXCEEDED",
            message="player ingest supports at most 10 player names per job",
            status_code=400,
            details={"count": len(normalized)},
        )
    return normalized


def _validate_parse_options(parse_profile: str, position_interval_seconds: int) -> None:
    if parse_profile not in PARSE_PROFILES:
        raise AppError(
            code="INGEST_PARSE_PROFILE_INVALID",
            message=f"parse_profile must be one of {sorted(PARSE_PROFILES)}",
            details={"parse_profile": parse_profile},
        )
    if position_interval_seconds <= 0:
        raise AppError(
            code="INGEST_POSITION_INTERVAL_INVALID",
            message="position_interval_seconds must be greater than zero",
            details={"position_interval_seconds": position_interval_seconds},
        )


def _empty_stats(*, total_count: int) -> dict[str, int]:
    return {
        "total_count": total_count,
        "success_count": 0,
        "skipped_count": 0,
        "failed_count": 0,
    }


def _log_parse_warnings(match_id: str, warnings: list[str]) -> None:
    for warning in warnings:
        logger.warning("match '%s' parse warning: %s", match_id, warning)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
