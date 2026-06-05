import sqlite3
from pathlib import Path

import pytest
from app.db.connection import connect_database
from app.db.migrations import initialize_database


def test_initialize_database_applies_initial_schema(database_path: Path) -> None:
    applied = initialize_database(database_path)

    assert [migration.version for migration in applied] == ["001"]

    with connect_database(database_path) as connection:
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }

    assert "schema_migrations" in tables
    assert "tournaments" in tables
    assert "matches" in tables
    assert "circle_phases" in tables
    assert "player_position_samples" in tables
    assert "hotspot_tiles" in tables
    assert "model_metrics" in tables


def test_initialize_database_is_idempotent(database_path: Path) -> None:
    first_run = initialize_database(database_path)
    second_run = initialize_database(database_path)

    assert [migration.version for migration in first_run] == ["001"]
    assert second_run == []


def test_foreign_keys_are_enforced(migrated_connection: sqlite3.Connection) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        migrated_connection.execute(
            """
            INSERT INTO matches (match_id, tournament_id, map_name)
            VALUES ('match-1', 'missing-tournament', 'Erangel_Main')
            """
        )
