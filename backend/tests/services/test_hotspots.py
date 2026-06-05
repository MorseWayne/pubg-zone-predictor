import sqlite3
from pathlib import Path

from app.db.repository import SQLiteRepository
from app.services.config_service import ConfigService
from app.services.hotspots import HotspotService


def _seed_hotspot_samples(connection: sqlite3.Connection) -> None:
    repo = SQLiteRepository(connection)
    repo.insert_or_ignore("tournaments", {"id": "tournament-1", "type": "tournament"})
    for match_id in ("match-1", "match-2"):
        repo.insert_or_ignore(
            "matches",
            {
                "match_id": match_id,
                "tournament_id": "tournament-1",
                "map_name": "Erangel_Main",
            },
        )
    for match_id, team_id, player_id in (
        ("match-1", "team-1", "player-1"),
        ("match-1", "team-2", "player-2"),
        ("match-2", "team-1", "player-3"),
    ):
        repo.insert_or_ignore("match_teams", {"match_id": match_id, "team_id": team_id})
        repo.insert_or_ignore(
            "match_rosters",
            {"match_id": match_id, "team_id": team_id, "player_id": player_id},
        )

    samples = [
        ("match-1", "player-1", "team-1", 10, 1000, 1000),
        ("match-1", "player-1", "team-1", 15, 1200, 1200),
        ("match-1", "player-2", "team-2", 10, 1000, 1000),
        ("match-2", "player-3", "team-1", 10, 200000, 200000),
    ]
    for match_id, player_id, team_id, elapsed_time, x, y in samples:
        repo.insert_or_ignore(
            "player_position_samples",
            {
                "match_id": match_id,
                "player_id": player_id,
                "team_id": team_id,
                "phase": 1,
                "elapsed_time": elapsed_time,
                "elapsed_time_bucket": elapsed_time,
                "x": x,
                "y": y,
            },
        )
    repo.insert_or_ignore(
        "player_life_events",
        {
            "match_id": "match-2",
            "elapsed_time": 30,
            "phase": 1,
            "event_type": "LogPlayerKill",
            "actor_player_id": "player-3",
            "victim_player_id": "player-2",
            "x": 200000,
            "y": 200000,
        },
    )
    connection.commit()


def test_generate_hotspots_normalizes_by_match_team_tiles(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_hotspot_samples(migrated_connection)
    service = HotspotService(migrated_connection, ConfigService(Path("config")))

    result = service.generate_hotspots("erangel", phase=1, grid_size=64)

    repo = SQLiteRepository(migrated_connection)
    top_tile = result.tiles[0]
    assert result.summary.effective_match_count == 2
    assert result.summary.effective_team_count == 3
    assert result.summary.tile_count == 2
    assert result.summary.max_sample_count == 2
    assert "low effective match count" in result.warnings[0]
    assert top_tile.tile_x == 0
    assert top_tile.tile_y == 0
    assert top_tile.density_score == 1
    assert top_tile.hotspot_score == 0.8
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM hotspot_tiles")["count"] == 2


def test_get_latest_hotspots_returns_last_generated_batch(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_hotspot_samples(migrated_connection)
    service = HotspotService(migrated_connection, ConfigService(Path("config")))
    generated = service.generate_hotspots("erangel", phase=1, grid_size=64)

    latest = service.get_latest_hotspots("erangel", phase=1, grid_size=64)

    assert latest.generated_at == generated.generated_at
    assert latest.summary.tile_count == 2
    assert latest.tiles[0].hotspot_score == 0.8
