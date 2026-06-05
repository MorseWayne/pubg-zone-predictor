from __future__ import annotations

import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from math import floor
from typing import Any

from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.config_service import ConfigService
from app.services.coordinates import CoordinateTransformer, Point

DEFAULT_GRID_SIZE = 64
MIN_EFFECTIVE_MATCHES = 10
MIN_EFFECTIVE_TEAMS = 30
DENSITY_WEIGHT = 0.8
KILL_DEATH_WEIGHT = 0.2


@dataclass(frozen=True)
class HotspotTile:
    tile_x: int
    tile_y: int
    density_score: float
    kill_death_score: float
    hotspot_score: float
    sample_count: int


@dataclass(frozen=True)
class HotspotSummary:
    effective_match_count: int
    effective_team_count: int
    tile_count: int
    max_sample_count: int


@dataclass(frozen=True)
class HotspotResult:
    map_id: str
    phase: int
    grid_size: int
    generated_at: str | None
    summary: HotspotSummary
    tiles: list[HotspotTile]
    warnings: list[str] = field(default_factory=list)


@dataclass
class HotspotService:
    connection: sqlite3.Connection
    config_service: ConfigService

    def __post_init__(self) -> None:
        self.repo = SQLiteRepository(self.connection)

    def generate_hotspots(
        self,
        map_id: str,
        phase: int,
        grid_size: int = DEFAULT_GRID_SIZE,
    ) -> HotspotResult:
        self._validate_phase_and_grid(phase, grid_size)
        map_config = self.config_service.get_map(map_id)
        normalized_map_id = map_config["map_id"]
        transformer = CoordinateTransformer.from_map_config(map_config)
        telemetry_names = self._telemetry_names(map_config)

        samples = self._position_samples(telemetry_names, phase)
        density_counts: Counter[tuple[int, int]] = Counter()
        team_tiles: set[tuple[str, str, int, int]] = set()
        effective_matches: set[str] = set()
        effective_teams: set[tuple[str, str]] = set()
        clamped_count = 0

        for sample in samples:
            point = Point(x=sample["x"], y=sample["y"])
            if self._is_out_of_bounds(transformer, point):
                clamped_count += 1
            tile_x, tile_y = self._tile_for_point(transformer, point, grid_size)
            team_key = (sample["match_id"], sample["team_id"], tile_x, tile_y)
            team_tiles.add(team_key)
            effective_matches.add(sample["match_id"])
            effective_teams.add((sample["match_id"], sample["team_id"]))

        for _match_id, _team_id, tile_x, tile_y in team_tiles:
            density_counts[(tile_x, tile_y)] += 1

        life_event_counts = self._life_event_counts(telemetry_names, phase, transformer, grid_size)
        warnings = self._warnings(len(effective_matches), len(effective_teams), clamped_count)
        tiles = self._score_tiles(density_counts, life_event_counts)
        generated_at = datetime.now(UTC).isoformat()

        for tile in tiles:
            self.repo.insert_or_ignore(
                "hotspot_tiles",
                {
                    "map_id": normalized_map_id,
                    "phase": phase,
                    "grid_size": grid_size,
                    "tile_x": tile.tile_x,
                    "tile_y": tile.tile_y,
                    "density_score": tile.density_score,
                    "kill_death_score": tile.kill_death_score,
                    "hotspot_score": tile.hotspot_score,
                    "sample_count": tile.sample_count,
                    "generated_at": generated_at,
                },
            )
        self.connection.commit()

        return HotspotResult(
            map_id=normalized_map_id,
            phase=phase,
            grid_size=grid_size,
            generated_at=generated_at,
            summary=HotspotSummary(
                effective_match_count=len(effective_matches),
                effective_team_count=len(effective_teams),
                tile_count=len(tiles),
                max_sample_count=max(density_counts.values(), default=0),
            ),
            tiles=tiles,
            warnings=warnings,
        )

    def get_latest_hotspots(
        self,
        map_id: str,
        phase: int,
        grid_size: int = DEFAULT_GRID_SIZE,
    ) -> HotspotResult:
        self._validate_phase_and_grid(phase, grid_size)
        normalized_map_id = self.config_service.get_map(map_id)["map_id"]
        latest = self.repo.fetch_one(
            """
            SELECT MAX(generated_at) AS generated_at
            FROM hotspot_tiles
            WHERE map_id = ? AND phase = ? AND grid_size = ?
            """,
            (normalized_map_id, phase, grid_size),
        )
        generated_at = latest["generated_at"] if latest else None
        if generated_at is None:
            raise AppError(
                code="HOTSPOTS_NOT_FOUND",
                message="hotspots have not been generated for this map and phase",
                status_code=404,
                details={"map_id": normalized_map_id, "phase": phase, "grid_size": grid_size},
            )

        rows = self.repo.fetch_all(
            """
            SELECT tile_x, tile_y, density_score, kill_death_score, hotspot_score, sample_count
            FROM hotspot_tiles
            WHERE map_id = ? AND phase = ? AND grid_size = ? AND generated_at = ?
            ORDER BY hotspot_score DESC, tile_x ASC, tile_y ASC
            """,
            (normalized_map_id, phase, grid_size, generated_at),
        )
        tiles = [self._tile_from_row(row) for row in rows]
        return HotspotResult(
            map_id=normalized_map_id,
            phase=phase,
            grid_size=grid_size,
            generated_at=generated_at,
            summary=HotspotSummary(
                effective_match_count=0,
                effective_team_count=0,
                tile_count=len(tiles),
                max_sample_count=max((tile.sample_count for tile in tiles), default=0),
            ),
            tiles=tiles,
        )

    def _position_samples(self, telemetry_names: list[str], phase: int) -> list[sqlite3.Row]:
        placeholders = ", ".join("?" for _ in telemetry_names)
        return self.repo.fetch_all(
            f"""
            SELECT p.match_id, p.team_id, p.x, p.y
            FROM player_position_samples p
            JOIN matches m ON m.match_id = p.match_id
            WHERE p.phase = ? AND m.map_name IN ({placeholders})
            """,
            (phase, *telemetry_names),
        )

    def _life_event_counts(
        self,
        telemetry_names: list[str],
        phase: int,
        transformer: CoordinateTransformer,
        grid_size: int,
    ) -> Counter[tuple[int, int]]:
        placeholders = ", ".join("?" for _ in telemetry_names)
        rows = self.repo.fetch_all(
            f"""
            SELECT e.x, e.y
            FROM player_life_events e
            JOIN matches m ON m.match_id = e.match_id
            WHERE e.phase = ?
              AND e.x IS NOT NULL
              AND e.y IS NOT NULL
              AND m.map_name IN ({placeholders})
            """,
            (phase, *telemetry_names),
        )
        counts: Counter[tuple[int, int]] = Counter()
        for row in rows:
            counts[self._tile_for_point(transformer, Point(x=row["x"], y=row["y"]), grid_size)] += 1
        return counts

    def _score_tiles(
        self,
        density_counts: Counter[tuple[int, int]],
        life_event_counts: Counter[tuple[int, int]],
    ) -> list[HotspotTile]:
        max_density = max(density_counts.values(), default=0)
        max_life_events = max(life_event_counts.values(), default=0)
        tiles: list[HotspotTile] = []
        for tile_key in sorted(set(density_counts) | set(life_event_counts)):
            density_score = density_counts[tile_key] / max_density if max_density else 0
            kill_death_score = (
                life_event_counts[tile_key] / max_life_events if max_life_events else 0
            )
            hotspot_score = DENSITY_WEIGHT * density_score + KILL_DEATH_WEIGHT * kill_death_score
            tiles.append(
                HotspotTile(
                    tile_x=tile_key[0],
                    tile_y=tile_key[1],
                    density_score=round(density_score, 6),
                    kill_death_score=round(kill_death_score, 6),
                    hotspot_score=round(hotspot_score, 6),
                    sample_count=density_counts[tile_key],
                )
            )
        return sorted(tiles, key=lambda tile: (-tile.hotspot_score, tile.tile_x, tile.tile_y))

    @staticmethod
    def _tile_for_point(
        transformer: CoordinateTransformer,
        point: Point,
        grid_size: int,
    ) -> tuple[int, int]:
        normalized = transformer.world_to_normalized(point, clamp=True)
        tile_x = min(floor(normalized.x * grid_size), grid_size - 1)
        tile_y = min(floor(normalized.y * grid_size), grid_size - 1)
        return int(tile_x), int(tile_y)

    @staticmethod
    def _is_out_of_bounds(transformer: CoordinateTransformer, point: Point) -> bool:
        return not (transformer.min_x <= point.x <= transformer.max_x) or not (
            transformer.min_y <= point.y <= transformer.max_y
        )

    @staticmethod
    def _telemetry_names(map_config: dict[str, Any]) -> list[str]:
        telemetry_names = [str(name) for name in map_config.get("telemetry_names", [])]
        if not telemetry_names:
            raise AppError(
                code="MAP_TELEMETRY_NAMES_MISSING",
                message="map config must contain telemetry_names for hotspot generation",
                status_code=500,
                details={"map_id": map_config.get("map_id")},
            )
        return telemetry_names

    @staticmethod
    def _validate_phase_and_grid(phase: int, grid_size: int) -> None:
        if phase < 1 or phase > 8:
            raise AppError(
                code="INVALID_PHASE",
                message="phase must be between 1 and 8",
                details={"phase": phase},
            )
        if grid_size <= 0:
            raise AppError(
                code="INVALID_GRID_SIZE",
                message="grid_size must be greater than zero",
                details={"grid_size": grid_size},
            )

    @staticmethod
    def _warnings(
        effective_match_count: int,
        effective_team_count: int,
        clamped_count: int,
    ) -> list[str]:
        warnings: list[str] = []
        if effective_match_count == 0:
            warnings.append("no player position samples found for this map and phase")
        if effective_match_count < MIN_EFFECTIVE_MATCHES:
            warnings.append(
                f"low effective match count: {effective_match_count} < {MIN_EFFECTIVE_MATCHES}"
            )
        if effective_team_count < MIN_EFFECTIVE_TEAMS:
            warnings.append(
                f"low effective team count: {effective_team_count} < {MIN_EFFECTIVE_TEAMS}"
            )
        if clamped_count:
            warnings.append(f"clamped {clamped_count} position samples to map bounds")
        return warnings

    @staticmethod
    def _tile_from_row(row: sqlite3.Row) -> HotspotTile:
        return HotspotTile(
            tile_x=row["tile_x"],
            tile_y=row["tile_y"],
            density_score=row["density_score"],
            kill_death_score=row["kill_death_score"],
            hotspot_score=row["hotspot_score"],
            sample_count=row["sample_count"],
        )
