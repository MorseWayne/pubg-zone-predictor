import json
import logging
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.ingest import IngestService


class FakePubgClient:
    def get_tournaments(self) -> dict[str, Any]:
        return {
            "data": [
                {
                    "id": "tournament-1",
                    "type": "tournament",
                    "attributes": {"createdAt": "2026-06-05T00:00:00Z"},
                },
                {"type": "tournament"},
            ]
        }

    def get_tournament(self, tournament_id: str) -> dict[str, Any]:
        return {
            "data": {
                "id": tournament_id,
                "type": "tournament",
                "attributes": {"createdAt": "2026-06-05T00:00:00Z"},
                "relationships": {
                    "matches": {
                        "data": [
                            {"id": "match-1"},
                            {"id": "match-2"},
                            {"id": "match-3"},
                        ]
                    }
                },
            }
        }

    def get_tournament_match(self, match_id: str) -> dict[str, Any]:
        if match_id == "match-3":
            raise AppError(code="PUBG_API_REQUEST_FAILED", message="boom", status_code=502)
        included = []
        if match_id == "match-1":
            included = [{"type": "asset", "attributes": {"URL": "https://telemetry.test/match-1.json"}}]
        return {
            "data": {
                "id": match_id,
                "attributes": {
                    "mapName": "Erangel_Main",
                    "shardId": "tournament",
                    "gameMode": "squad-fpp",
                    "matchType": "competitive",
                    "createdAt": "2026-06-05T00:00:00Z",
                    "duration": 1800,
                },
            },
            "included": included,
        }

    def get_match_samples(self, platform: str) -> dict[str, Any]:
        assert platform == "steam"
        return {
            "data": {
                "id": "sample-1",
                "type": "sample",
                "relationships": {
                    "matches": {
                        "data": [
                            {"id": "sample-match-1"},
                            {"id": "sample-match-2"},
                            {"id": "sample-match-3"},
                        ]
                    }
                },
            }
        }

    def get_match(self, match_id: str, platform: str) -> dict[str, Any]:
        assert platform == "steam"
        game_mode = "squad"
        match_type = "official"
        if match_id == "sample-match-2":
            game_mode = "squad-fpp"
        if match_id == "sample-match-3":
            match_type = "custom"
        return {
            "data": {
                "id": match_id,
                "attributes": {
                    "mapName": "Erangel_Main",
                    "shardId": "steam",
                    "gameMode": game_mode,
                    "matchType": match_type,
                    "createdAt": "2026-06-05T00:00:00Z",
                    "duration": 1800,
                },
            },
            "included": [
                {
                    "type": "asset",
                    "attributes": {"URL": f"https://telemetry.test/{match_id}.json"},
                }
            ],
        }

    def download_telemetry(self, telemetry_url: str) -> bytes:
        assert telemetry_url.startswith("https://telemetry.test/")
        return json.dumps(
            [
                {
                    "_T": "LogGameStatePeriodic",
                    "common": {"isGame": 1},
                    "gameState": {
                        "elapsedTime": 60,
                        "numAliveTeams": 16,
                        "numAlivePlayers": 64,
                        "poisonGasWarningPosition": {"x": 400000, "y": 410000},
                        "poisonGasWarningRadius": 400000,
                    },
                }
            ]
        ).encode()


class WarningTelemetryPubgClient(FakePubgClient):
    def download_telemetry(self, telemetry_url: str) -> bytes:
        assert telemetry_url.startswith("https://telemetry.test/")
        return json.dumps(
            [
                {
                    "_T": "LogGameStatePeriodic",
                    "common": {},
                    "gameState": {
                        "elapsedTime": 60,
                        "numAliveTeams": 16,
                        "numAlivePlayers": 64,
                        "poisonGasWarningPosition": {"x": 400000, "y": 410000},
                        "poisonGasWarningRadius": 400000,
                    },
                }
            ]
        ).encode()


def test_ingest_tournaments_upserts_tournament_rows(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)

    job = service.ingest_tournaments()

    repo = SQLiteRepository(migrated_connection)
    assert job.status == "completed"
    assert job.total_count == 2
    assert job.success_count == 1
    assert job.skipped_count == 1
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM tournaments")["count"] == 1


def test_ingest_tournament_records_matches_telemetry_and_partial_failures(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)

    job = service.ingest_tournament("tournament-1")

    repo = SQLiteRepository(migrated_connection)
    assert job.status == "completed"
    assert job.total_count == 3
    assert job.success_count == 1
    assert job.skipped_count == 1
    assert job.failed_count == 1
    assert len(job.warnings) == 2
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM matches")["count"] == 2
    assert repo.fetch_one("SELECT telemetry_url FROM telemetry_assets WHERE match_id = 'match-1'")[
        "telemetry_url"
    ] == "https://telemetry.test/match-1.json"


def test_ingest_sample_matches_keeps_regular_squad_matches(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)

    job = service.ingest_sample_matches()

    repo = SQLiteRepository(migrated_connection)
    assert job.status == "completed"
    assert job.job_type == "sample_matches"
    assert job.source_ref == "samples:steam:squad:profile=hotspot_light:interval=30"
    assert job.total_count == 3
    assert job.success_count == 1
    assert job.skipped_count == 2
    assert len(job.warnings) == 2
    row = repo.fetch_one(
        "SELECT tournament_id, game_mode, match_type FROM matches WHERE match_id = 'sample-match-1'"
    )
    assert row["tournament_id"] is None
    assert row["game_mode"] == "squad"
    assert row["match_type"] == "official"
    asset = repo.fetch_one(
        "SELECT telemetry_url, parse_status FROM telemetry_assets WHERE match_id = 'sample-match-1'"
    )
    assert asset["telemetry_url"] == "https://telemetry.test/sample-match-1.json"
    assert asset["parse_status"] == "completed"
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM matches")["count"] == 1
    assert repo.fetch_one(
        "SELECT COUNT(*) AS count FROM circle_phases WHERE match_id = 'sample-match-1'"
    )["count"] == 1


def test_ingest_sample_matches_respects_max_matches_limit(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)

    job = service.ingest_sample_matches(max_matches=1)

    repo = SQLiteRepository(migrated_connection)
    assert job.status == "completed"
    assert job.source_ref == "samples:steam:squad:max=1:profile=hotspot_light:interval=30"
    assert job.total_count == 1
    assert job.success_count == 1
    assert job.skipped_count == 0
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM matches")["count"] == 1


def test_cancelled_sample_match_job_stops_before_processing_matches(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    job = service.start_sample_matches(max_matches=2)

    cancelled = service.cancel_job(job.id)
    service.run_sample_matches_job(job.id, max_matches=2)

    repo = SQLiteRepository(migrated_connection)
    latest = service.get_job(job.id)
    assert cancelled.status == "cancelled"
    assert latest.status == "cancelled"
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM matches")["count"] == 0


def test_ingest_sample_matches_logs_parse_warnings_without_returning_them(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger="app.services.ingest")
    service = IngestService(migrated_connection, WarningTelemetryPubgClient(), tmp_path)

    job = service.ingest_sample_matches()

    assert job.status == "completed"
    assert job.success_count == 1
    assert job.skipped_count == 2
    assert all("parse warning" not in warning for warning in job.warnings)
    assert "match 'sample-match-1' parse warning: skipped incomplete circle phase sample" in (
        caplog.text
    )


def test_start_sample_matches_returns_running_job_without_fetching_committed_row(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)

    job = service.start_sample_matches()

    assert job.status == "running"
    assert job.job_type == "sample_matches"
    assert job.source_ref == "samples:steam:squad:profile=hotspot_light:interval=30"
    assert job.total_count == 0


def test_start_sample_matches_reports_unmigrated_job_schema(
    database_path: Path,
    tmp_path: Path,
) -> None:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE ingest_jobs (
            id TEXT PRIMARY KEY,
            job_type TEXT NOT NULL CHECK (job_type IN ('tournament_list')),
            status TEXT NOT NULL,
            source_ref TEXT,
            total_count INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            started_at TEXT,
            finished_at TEXT,
            error_code TEXT,
            error_message TEXT
        )
        """
    )
    try:
        service = IngestService(connection, FakePubgClient(), tmp_path)

        with pytest.raises(AppError) as exc_info:
            service.start_sample_matches()
    finally:
        connection.close()

    assert exc_info.value.code == "INGEST_JOB_CREATE_FAILED"


def test_download_match_telemetry_caches_content_and_updates_asset(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    service.ingest_tournament("tournament-1")

    job = service.download_match_telemetry("match-1")

    repo = SQLiteRepository(migrated_connection)
    asset = repo.fetch_one(
        "SELECT cache_path, content_hash FROM telemetry_assets WHERE match_id = 'match-1'"
    )
    assert job.status == "completed"
    assert job.success_count == 1
    assert Path(asset["cache_path"]).read_text(encoding="utf-8").startswith("[")
    assert len(asset["content_hash"]) == 64


def test_parse_match_telemetry_writes_training_rows(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    service.ingest_tournament("tournament-1")
    service.download_match_telemetry("match-1")

    job = service.parse_match_telemetry("match-1")

    repo = SQLiteRepository(migrated_connection)
    asset = repo.fetch_one("SELECT parse_status FROM telemetry_assets WHERE match_id = 'match-1'")
    assert job.status == "completed"
    assert job.job_type == "telemetry_parse"
    assert job.success_count == 1
    assert asset["parse_status"] == "completed"
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM circle_phases")["count"] == 1


def test_retry_job_starts_new_job_with_incremented_retry_count(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    original = service.ingest_tournament("tournament-1")

    retried = service.retry_job(original.id)

    assert retried.id != original.id
    assert retried.retry_count == 1
    assert retried.source_ref == "tournament-1"
