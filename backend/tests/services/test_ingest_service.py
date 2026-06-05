import json
import sqlite3
from pathlib import Path
from typing import Any

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

    def download_telemetry(self, telemetry_url: str) -> bytes:
        assert telemetry_url == "https://telemetry.test/match-1.json"
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
