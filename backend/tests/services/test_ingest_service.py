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

    def get_players_by_names(self, platform: str, player_names: list[str]) -> dict[str, Any]:
        assert platform == "steam"
        assert player_names == ["PlayerOne", "PlayerTwo"]
        return {
            "data": [
                {
                    "id": "account.1",
                    "type": "player",
                    "attributes": {"name": "PlayerOne"},
                    "relationships": {
                        "matches": {
                            "data": [
                                {"id": "player-match-1"},
                                {"id": "player-match-2"},
                            ]
                        }
                    },
                },
                {
                    "id": "account.2",
                    "type": "player",
                    "attributes": {"name": "PlayerTwo"},
                    "relationships": {
                        "matches": {
                            "data": [
                                {"id": "player-match-1"},
                                {"id": "player-match-3"},
                            ]
                        }
                    },
                },
            ]
        }

    def get_match(self, match_id: str, platform: str) -> dict[str, Any]:
        assert platform == "steam"
        game_mode = "squad"
        match_type = "official"
        if match_id == "sample-match-2":
            game_mode = "squad-fpp"
        if match_id == "sample-match-3":
            match_type = "custom"
        if match_id == "player-match-3":
            game_mode = "duo"
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


class AnalysisTelemetryPubgClient(FakePubgClient):
    def download_telemetry(self, telemetry_url: str) -> bytes:
        assert telemetry_url == "https://telemetry.test/match-auto.json"
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
                },
                {
                    "_T": "LogPlayerPosition",
                    "common": {"isGame": 1, "elapsedTime": 62},
                    "character": {
                        "accountId": "account.1",
                        "name": "PlayerOne",
                        "teamId": 1,
                        "location": {"x": 401000, "y": 411000, "z": 120},
                        "health": 100,
                    },
                },
                {
                    "_T": "LogPlayerKill",
                    "common": {"isGame": 1, "elapsedTime": 120},
                    "attacker": {
                        "accountId": "account.1",
                        "name": "PlayerOne",
                        "teamId": 1,
                        "location": {"x": 405000, "y": 412000},
                    },
                    "victim": {
                        "accountId": "account.2",
                        "name": "PlayerTwo",
                        "teamId": 2,
                        "location": {"x": 405000, "y": 412000},
                    },
                },
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


def test_ingest_player_matches_deduplicates_recent_player_matches(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)

    job = service.ingest_player_matches(
        player_names=["PlayerOne", "PlayerTwo"],
        max_matches_per_player=2,
    )

    repo = SQLiteRepository(migrated_connection)
    assert job.status == "completed"
    assert job.job_type == "player_matches"
    assert job.source_ref == (
        "players:steam:squad:names=PlayerOne,PlayerTwo:max=2:"
        "profile=hotspot_light:interval=30"
    )
    assert job.total_count == 3
    assert job.success_count == 2
    assert job.skipped_count == 1
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM matches")["count"] == 2
    assert repo.fetch_one(
        "SELECT COUNT(*) AS count FROM circle_phases WHERE match_id = 'player-match-1'"
    )["count"] == 1


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


def test_get_match_analysis_returns_players_route_and_events(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    repo = SQLiteRepository(migrated_connection)
    repo.execute(
        """
        INSERT INTO matches (
            match_id,
            map_name,
            shard_id,
            game_mode,
            match_type,
            created_at,
            duration,
            telemetry_url,
            ingest_status
        )
        VALUES (
            'match-analysis',
            'Erangel_Main',
            'steam',
            'squad',
            'official',
            '2026-06-05T00:00:00Z',
            1800,
            'https://telemetry.test/match-analysis.json',
            'completed'
        )
        """
    )
    repo.execute(
        """
        INSERT INTO telemetry_assets (
            match_id,
            telemetry_url,
            parse_status,
            parse_profile,
            position_interval_seconds,
            parsed_at
        )
        VALUES (
            'match-analysis',
            'https://telemetry.test/match-analysis.json',
            'completed',
            'full',
            5,
            '2026-06-05T00:02:00+00:00'
        )
        """
    )
    repo.execute(
        """
        INSERT INTO match_teams (match_id, team_id, team_rank)
        VALUES ('match-analysis', 'team-1', 2)
        """
    )
    repo.execute(
        """
        INSERT INTO match_rosters (match_id, team_id, player_id, player_name)
        VALUES ('match-analysis', 'team-1', 'account.1', 'PlayerOne')
        """
    )
    repo.execute(
        """
        INSERT INTO circle_phases (
            match_id,
            phase,
            elapsed_time,
            center_x,
            center_y,
            radius,
            num_alive_teams,
            num_alive_players
        )
        VALUES ('match-analysis', 1, 60, 400000, 410000, 400000, 16, 64)
        """
    )
    repo.execute(
        """
        INSERT INTO player_position_samples (
            match_id,
            player_id,
            team_id,
            phase,
            elapsed_time,
            elapsed_time_bucket,
            x,
            y,
            alive
        )
        VALUES ('match-analysis', 'account.1', 'team-1', 1, 62, 12, 401000, 411000, 1)
        """
    )
    repo.execute(
        """
        INSERT INTO player_life_events (
            match_id,
            elapsed_time,
            phase,
            event_type,
            actor_player_id,
            victim_player_id,
            x,
            y
        )
        VALUES ('match-analysis', 120, 1, 'LogPlayerKill', 'account.1', 'account.2', 405000, 412000)
        """
    )
    migrated_connection.commit()

    analysis = service.get_match_analysis("match-analysis")

    assert analysis.match.match_id == "match-analysis"
    assert analysis.players[0].player_name == "PlayerOne"
    assert analysis.players[0].team_rank == 2
    assert analysis.circles[0].center_x == 400000
    assert analysis.positions[0].alive is True
    assert analysis.life_events[0].actor_player_name == "PlayerOne"
    assert analysis.life_events[0].x == 405000


def test_team_dashboard_uses_recent_squad_teammates_and_selected_stats(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    repo = SQLiteRepository(migrated_connection)
    repo.executemany(
        """
        INSERT INTO matches (
            match_id,
            map_name,
            shard_id,
            game_mode,
            match_type,
            created_at,
            duration,
            telemetry_url,
            ingest_status
        )
        VALUES (?, 'Erangel_Main', 'steam', 'squad', 'official', ?, 1800, ?, 'completed')
        """,
        [
            ("match-new", "2026-06-06T00:00:00Z", "https://telemetry.test/match-new.json"),
            ("match-old", "2026-06-05T00:00:00Z", "https://telemetry.test/match-old.json"),
        ],
    )
    repo.executemany(
        """
        INSERT INTO match_teams (match_id, team_id, team_rank)
        VALUES (?, 'team-1', ?)
        """,
        [("match-new", 1), ("match-old", 5)],
    )
    repo.executemany(
        """
        INSERT INTO match_rosters (match_id, team_id, player_id, player_name)
        VALUES (?, 'team-1', ?, ?)
        """,
        [
            ("match-new", "account.1", "PlayerOne"),
            ("match-new", "account.3", "PlayerThree"),
            ("match-old", "account.1", "PlayerOne"),
            ("match-old", "account.2", "PlayerTwo"),
        ],
    )
    repo.executemany(
        """
        INSERT INTO player_life_events (
            match_id,
            elapsed_time,
            phase,
            event_type,
            actor_player_id,
            victim_player_id,
            x,
            y,
            damage
        )
        VALUES (?, ?, 1, ?, ?, ?, 405000, 412000, ?)
        """,
        [
            ("match-new", 120, "LogPlayerKill", "account.1", "enemy.1", None),
            ("match-new", 122, "LogPlayerTakeDamage", "account.3", "enemy.2", 40.0),
            ("match-old", 120, "LogPlayerTakeDamage", "account.1", "enemy.4", 80.0),
            ("match-old", 122, "LogPlayerTakeDamage", "account.2", "enemy.5", 55.5),
            ("match-old", 130, "LogPlayerKill", "enemy.3", "account.2", None),
        ],
    )
    migrated_connection.commit()

    players = service.list_local_players(limit=10)
    dashboard = service.get_team_dashboard(
        "account.1",
        teammate_ids=["account.2"],
        match_limit=1,
        teammate_candidate_limit=2,
    )

    assert [player.player_name for player in players[:3]] == [
        "PlayerOne",
        "PlayerThree",
        "PlayerTwo",
    ]
    assert dashboard.primary_player.player_name == "PlayerOne"
    assert [player.player_id for player in dashboard.teammates[:2]] == ["account.3", "account.2"]
    assert [player.player_id for player in dashboard.selected_players] == ["account.1", "account.2"]
    primary, teammate = dashboard.selected_players
    assert primary.match_count == 1
    assert primary.wins == 0
    assert primary.avg_rank == 5
    assert primary.kills == 0
    assert primary.damage == 80
    assert teammate.knocks == 0
    assert teammate.deaths == 1
    assert teammate.damage == 55.5
    assert dashboard.matches[0].match_id == "match-old"
    assert dashboard.matches[0].kills == 0
    assert dashboard.matches[0].damage == 135.5


def test_get_match_analysis_downloads_and_parses_missing_telemetry_data(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, AnalysisTelemetryPubgClient(), tmp_path)
    repo = SQLiteRepository(migrated_connection)
    repo.execute(
        """
        INSERT INTO matches (
            match_id,
            map_name,
            shard_id,
            game_mode,
            match_type,
            created_at,
            duration,
            telemetry_url,
            ingest_status
        )
        VALUES (
            'match-auto',
            'Erangel_Main',
            'steam',
            'squad',
            'official',
            '2026-06-05T00:00:00Z',
            1800,
            'https://telemetry.test/match-auto.json',
            'completed'
        )
        """
    )
    migrated_connection.commit()

    analysis = service.get_match_analysis("match-auto")

    asset = repo.fetch_one(
        """
        SELECT cache_path, parse_status, parse_profile, position_interval_seconds, parsed_at
        FROM telemetry_assets
        WHERE match_id = 'match-auto'
        """
    )
    assert asset["parse_status"] == "completed"
    assert asset["parse_profile"] == "full"
    assert asset["position_interval_seconds"] == 5
    assert asset["parsed_at"] is not None
    assert Path(asset["cache_path"]).exists()
    assert analysis.match.circle_phase_count == 1
    assert analysis.match.position_sample_count == 1
    assert analysis.match.life_event_count == 1
    assert analysis.players[0].player_name == "PlayerOne"
    assert analysis.positions[0].x == 401000
    assert analysis.life_events[0].event_type == "LogPlayerKill"


def test_get_match_analysis_backfills_cached_damage_for_existing_analysis(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    repo = SQLiteRepository(migrated_connection)
    cache_path = tmp_path / "match-damage.json"
    cache_path.write_text(
        json.dumps(
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
                },
                {
                    "_T": "LogPlayerTakeDamage",
                    "common": {"isGame": 1, "elapsedTime": 120},
                    "attacker": {
                        "accountId": "account.1",
                        "name": "PlayerOne",
                        "teamId": 1,
                        "location": {"x": 405000, "y": 412000},
                    },
                    "victim": {
                        "accountId": "account.2",
                        "name": "PlayerTwo",
                        "teamId": 2,
                        "location": {"x": 405000, "y": 412000},
                    },
                    "damage": 18.75,
                },
            ]
        ),
        encoding="utf-8",
    )
    repo.execute(
        """
        INSERT INTO matches (
            match_id,
            map_name,
            shard_id,
            game_mode,
            match_type,
            created_at,
            duration,
            telemetry_url,
            ingest_status
        )
        VALUES (
            'match-damage',
            'Erangel_Main',
            'steam',
            'squad',
            'official',
            '2026-06-05T00:00:00Z',
            1800,
            'https://telemetry.test/match-damage.json',
            'completed'
        )
        """
    )
    repo.execute(
        """
        INSERT INTO telemetry_assets (
            match_id,
            telemetry_url,
            cache_path,
            parse_status,
            parse_profile,
            position_interval_seconds,
            parsed_at
        )
        VALUES (
            'match-damage',
            'https://telemetry.test/match-damage.json',
            ?,
            'completed',
            'full',
            5,
            '2026-06-05T00:02:00+00:00'
        )
        """,
        (str(cache_path),),
    )
    repo.execute(
        """
        INSERT INTO circle_phases (
            match_id,
            phase,
            elapsed_time,
            center_x,
            center_y,
            radius,
            num_alive_teams,
            num_alive_players
        )
        VALUES ('match-damage', 1, 60, 400000, 410000, 400000, 16, 64)
        """
    )
    repo.execute(
        """
        INSERT INTO player_life_events (
            match_id,
            elapsed_time,
            phase,
            event_type,
            actor_player_id,
            victim_player_id,
            x,
            y,
            damage
        )
        VALUES (
            'match-damage',
            120,
            NULL,
            'LogPlayerTakeDamage',
            'account.1',
            'account.2',
            405000,
            412000,
            NULL
        )
        """
    )
    migrated_connection.commit()

    analysis = service.get_match_analysis("match-damage")

    assert analysis.life_events[0].damage == 18.75


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


def test_retry_jobs_starts_new_jobs_for_each_selected_job(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    first = service.ingest_tournament("tournament-1")
    second = service.ingest_tournament("tournament-1")

    retried = service.retry_jobs([first.id, second.id])

    assert len(retried) == 2
    assert {job.retry_count for job in retried} == {1}
    assert all(job.id not in {first.id, second.id} for job in retried)


def test_cancel_jobs_cancels_each_selected_running_job(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    first = service.start_sample_matches(max_matches=1)
    second = service.start_sample_matches(max_matches=1)

    cancelled = service.cancel_jobs([first.id, second.id])

    assert [job.status for job in cancelled] == ["cancelled", "cancelled"]
    assert service.get_job(first.id).status == "cancelled"
    assert service.get_job(second.id).status == "cancelled"


def test_delete_job_removes_terminal_job_history_only(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    job = service.ingest_tournament("tournament-1")
    repo = SQLiteRepository(migrated_connection)
    match_count = repo.fetch_one("SELECT COUNT(*) AS count FROM matches")["count"]

    result = service.delete_job(job.id)

    assert result.job_id == job.id
    assert result.deleted is True
    with pytest.raises(AppError) as exc_info:
        service.get_job(job.id)
    assert exc_info.value.code == "INGEST_JOB_NOT_FOUND"
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM matches")["count"] == match_count


def test_delete_job_rejects_running_job(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    job = service.start_sample_matches(max_matches=1)

    with pytest.raises(AppError) as exc_info:
        service.delete_job(job.id)

    assert exc_info.value.code == "INGEST_JOB_RUNNING"
    assert exc_info.value.status_code == 409
    assert service.get_job(job.id).status == "running"


def test_delete_jobs_removes_each_selected_terminal_job(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = IngestService(migrated_connection, FakePubgClient(), tmp_path)
    first = service.ingest_tournament("tournament-1")
    second = service.ingest_tournament("tournament-1")

    deleted = service.delete_jobs([first.id, second.id])

    assert [result.job_id for result in deleted] == [first.id, second.id]
    assert all(result.deleted for result in deleted)
    remaining = SQLiteRepository(migrated_connection).fetch_one(
        "SELECT COUNT(*) AS count FROM ingest_jobs WHERE id IN (?, ?)",
        (first.id, second.id),
    )
    assert remaining["count"] == 0
