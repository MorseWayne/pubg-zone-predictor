import json
import sqlite3
from pathlib import Path

from app.db.repository import SQLiteRepository
from app.services.telemetry_parser import TelemetryParser

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "telemetry_sample.json"


def _seed_match(connection: sqlite3.Connection) -> None:
    repo = SQLiteRepository(connection)
    repo.insert_or_ignore("tournaments", {"id": "tournament-1", "type": "tournament"})
    repo.insert_or_ignore(
        "matches",
        {
            "match_id": "match-1",
            "tournament_id": "tournament-1",
            "map_name": "Erangel_Main",
        },
    )
    connection.commit()


def test_telemetry_parser_extracts_circles_positions_rosters_and_life_events(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    events = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    result = TelemetryParser(migrated_connection).parse_match("match-1", events)

    repo = SQLiteRepository(migrated_connection)
    assert result.event_count == 7
    assert result.circle_phase_count == 2
    assert result.team_count == 3
    assert result.position_sample_count == 2
    assert result.life_event_count == 1
    phase_one = repo.fetch_one("SELECT center_x FROM circle_phases WHERE phase = 1")
    assert phase_one["center_x"] == 400000
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM match_rosters")["count"] == 3
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_position_samples")["count"] == 2
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_life_events")["count"] == 1
    assert repo.fetch_one("SELECT is_unknown FROM match_teams WHERE team_id = 'unknown'")[
        "is_unknown"
    ] == 1


def test_telemetry_parser_is_idempotent(migrated_connection: sqlite3.Connection) -> None:
    _seed_match(migrated_connection)
    events = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    parser = TelemetryParser(migrated_connection)

    first = parser.parse_match("match-1", events)
    second = parser.parse_match("match-1", events)

    repo = SQLiteRepository(migrated_connection)
    assert first.circle_phase_count == 2
    assert second.circle_phase_count == 0
    assert second.position_sample_count == 0
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM circle_phases")["count"] == 2
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_position_samples")["count"] == 2


def test_telemetry_parser_zone_only_skips_position_and_life_tables(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    events = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    result = TelemetryParser(migrated_connection, parse_profile="zone_only").parse_match(
        "match-1",
        events,
    )

    repo = SQLiteRepository(migrated_connection)
    assert result.circle_phase_count == 2
    assert result.team_count == 0
    assert result.roster_count == 0
    assert result.position_sample_count == 0
    assert result.life_event_count == 0
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_position_samples")["count"] == 0
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_life_events")["count"] == 0


def test_telemetry_parser_hotspot_light_skips_positions_without_phase(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    events = [
        {
            "_T": "LogGameStatePeriodic",
            "common": {"isGame": 1},
            "gameState": {
                "elapsedTime": 60,
                "poisonGasWarningPosition": {"x": 400000, "y": 410000},
                "poisonGasWarningRadius": 400000,
            },
        },
        {
            "_T": "LogPlayerPosition",
            "common": {"elapsedTime": 61.2},
            "character": {
                "accountId": "account-1",
                "teamId": 101,
                "health": 100,
                "location": {"x": 1000, "y": 2000},
            },
        },
    ]

    result = TelemetryParser(
        migrated_connection,
        sample_interval_seconds=30,
        parse_profile="hotspot_light",
    ).parse_match("match-1", events)

    repo = SQLiteRepository(migrated_connection)
    assert result.circle_phase_count == 1
    assert result.position_sample_count == 0
    assert "skipped player position sample without phase" in result.warnings
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_position_samples")["count"] == 0
