import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from app.db.connection import connect_database
from app.db.migrations import initialize_database

EXPECTED_MIGRATIONS = ["001", "002", "003", "004", "005", "006", "007", "008"]


def test_initialize_database_applies_initial_schema(database_path: Path) -> None:
    applied = initialize_database(database_path)

    assert [migration.version for migration in applied] == EXPECTED_MIGRATIONS

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

    with connect_database(database_path) as connection:
        model_metric_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(model_metrics)").fetchall()
        }
    assert "split" in model_metric_columns

    with connect_database(database_path) as connection:
        telemetry_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(telemetry_assets)").fetchall()
        }
    assert "parse_profile" in telemetry_columns
    assert "position_interval_seconds" in telemetry_columns
    assert "parsed_at" in telemetry_columns
    assert "replay_schema_version" in telemetry_columns

    with connect_database(database_path) as connection:
        position_columns = {
            row["name"]
            for row in connection.execute(
                "PRAGMA table_info(player_position_samples)"
            ).fetchall()
        }
    assert "health" in position_columns
    assert "movement_mode" in position_columns
    assert "vehicle_type" in position_columns
    assert "vehicle_id" in position_columns
    assert "vehicle_seat_index" in position_columns

    with connect_database(database_path) as connection:
        life_event_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(player_life_events)").fetchall()
        }
    assert "damage" in life_event_columns
    assert "damage_causer_name" in life_event_columns
    assert "damage_reason" in life_event_columns

    with connect_database(database_path) as connection:
        connection.execute(
            """
            INSERT INTO ingest_jobs (id, job_type, status)
            VALUES ('job_sample', 'sample_matches', 'completed')
            """
        )
        connection.execute(
            """
            INSERT INTO ingest_jobs (id, job_type, status)
            VALUES ('job_player', 'player_matches', 'completed')
            """
        )


def test_initialize_database_is_idempotent(database_path: Path) -> None:
    first_run = initialize_database(database_path)
    second_run = initialize_database(database_path)

    assert [migration.version for migration in first_run] == EXPECTED_MIGRATIONS
    assert second_run == []


def test_foreign_keys_are_enforced(migrated_connection: sqlite3.Connection) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        migrated_connection.execute(
            """
            INSERT INTO matches (match_id, tournament_id, map_name)
            VALUES ('match-1', 'missing-tournament', 'Erangel_Main')
            """
        )


def test_database_connection_can_cross_worker_threads(database_path: Path) -> None:
    with ThreadPoolExecutor(max_workers=1) as executor:
        connection = executor.submit(connect_database, database_path).result()

    try:
        connection.execute("CREATE TABLE thread_probe (id INTEGER PRIMARY KEY)")
        connection.execute("INSERT INTO thread_probe DEFAULT VALUES")
        row = connection.execute("SELECT COUNT(*) AS count FROM thread_probe").fetchone()
    finally:
        connection.close()

    assert row["count"] == 1
