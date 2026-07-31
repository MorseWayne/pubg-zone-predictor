import json
import sqlite3
from pathlib import Path

import pytest

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
    assert [
        row["health"]
        for row in repo.fetch_all(
            "SELECT health FROM player_position_samples ORDER BY elapsed_time"
        )
    ] == [100.0, 90.0]
    movement_rows = repo.fetch_all(
        """
        SELECT movement_mode, vehicle_type, vehicle_id, vehicle_seat_index
        FROM player_position_samples
        ORDER BY elapsed_time
        """
    )
    assert [row["movement_mode"] for row in movement_rows] == ["foot", "vehicle"]
    assert movement_rows[1]["vehicle_type"] == "WheeledVehicle"
    assert movement_rows[1]["vehicle_id"] == "Dacia_A_01_C"
    assert movement_rows[1]["vehicle_seat_index"] == 0
    assert repo.fetch_one("SELECT is_unknown FROM match_teams WHERE team_id = 'unknown'")[
        "is_unknown"
    ] == 1


def test_telemetry_parser_derives_elapsed_time_from_event_timestamps(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    events = [
        {"_T": "LogMatchStart", "_D": "2026-06-05T00:00:00Z", "common": {"isGame": 0}},
        {
            "_T": "LogGameStatePeriodic",
            "_D": "2026-06-05T00:01:00Z",
            "common": {"isGame": 1},
            "gameState": {
                "numAliveTeams": 16,
                "numAlivePlayers": 64,
                "poisonGasWarningPosition": {"x": 400000, "y": 410000},
                "poisonGasWarningRadius": 400000,
            },
        },
        {
            "_T": "LogPlayerPosition",
            "_D": "2026-06-05T00:01:01.200Z",
            "common": {"isGame": 1},
            "character": {
                "accountId": "account-1",
                "name": "PlayerOne",
                "teamId": 101,
                "health": 100,
                "location": {"x": 1000, "y": 2000, "z": 300},
            },
            "vehicle": None,
        },
        {
            "_T": "LogPlayerTakeDamage",
            "_D": "2026-06-05T00:04:30Z",
            "common": {"isGame": 2},
            "attacker": {
                "accountId": "account-1",
                "name": "PlayerOne",
                "teamId": 101,
                "location": {"x": 2050, "y": 3050},
            },
            "victim": {
                "accountId": "account-2",
                "name": "PlayerTwo",
                "teamId": 102,
                "location": {"x": 2100, "y": 3100},
            },
            "damage": 18.75,
            "damageCauserName": "WeapAK47_C",
            "damageReason": "HeadShot",
        },
    ]

    result = TelemetryParser(migrated_connection).parse_match("match-1", events)

    repo = SQLiteRepository(migrated_connection)
    assert result.circle_phase_count == 1
    assert result.position_sample_count == 1
    assert result.life_event_count == 1
    circle = repo.fetch_one("SELECT elapsed_time FROM circle_phases WHERE phase = 1")
    position = repo.fetch_one("SELECT elapsed_time FROM player_position_samples")
    life_event = repo.fetch_one(
        """
        SELECT
            elapsed_time,
            actor_player_id,
            victim_player_id,
            x,
            y,
            damage,
            damage_causer_name,
            damage_reason
        FROM player_life_events
        """
    )
    assert circle["elapsed_time"] == 60
    assert position["elapsed_time"] == 61.2
    assert life_event["elapsed_time"] == 270
    assert life_event["actor_player_id"] == "account-1"
    assert life_event["victim_player_id"] == "account-2"
    assert life_event["x"] == 2100
    assert life_event["y"] == 3100
    assert life_event["damage"] == 18.75
    assert life_event["damage_causer_name"] == "WeapAK47_C"
    assert life_event["damage_reason"] == "HeadShot"


def test_telemetry_parser_uses_match_start_for_mixed_event_clocks(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    events = [
        {
            "_T": "LogPlayerPosition",
            "_D": "2026-06-04T23:59:00Z",
            "elapsedTime": 0,
            "common": {"isGame": 0},
            "character": {
                "accountId": "account-lobby",
                "name": "LobbyPlayer",
                "teamId": 99,
                "health": 100,
                "location": {"x": 100, "y": 200},
            },
            "vehicle": None,
        },
        {"_T": "LogMatchStart", "_D": "2026-06-05T00:00:00Z", "common": {"isGame": 0}},
        {
            "_T": "LogPlayerPosition",
            "_D": "2026-06-05T00:00:10Z",
            "elapsedTime": 3,
            "common": {"isGame": 1},
            "character": {
                "accountId": "account-1",
                "name": "PlayerOne",
                "teamId": 1,
                "health": 100,
                "location": {"x": 1000, "y": 2000},
            },
            "vehicle": None,
        },
        {
            "_T": "LogPlayerMakeGroggy",
            "_D": "2026-06-05T00:00:12Z",
            "common": {"isGame": 1},
            "attacker": {"accountId": "account-2", "name": "PlayerTwo", "teamId": 2},
            "victim": {"accountId": "account-1", "name": "PlayerOne", "teamId": 1},
        },
        {
            "_T": "LogPlayerRevive",
            "_D": "2026-06-05T00:00:20Z",
            "common": {"isGame": 1},
            "victim": {"accountId": "account-1", "name": "PlayerOne", "teamId": 1},
        },
    ]

    result = TelemetryParser(migrated_connection).parse_match("match-1", events)

    repo = SQLiteRepository(migrated_connection)
    assert result.position_sample_count == 1
    assert result.life_event_count == 2
    assert repo.fetch_one(
        "SELECT COUNT(*) AS count FROM match_rosters WHERE player_id = 'account-lobby'"
    )["count"] == 0
    assert repo.fetch_one("SELECT elapsed_time FROM player_position_samples")[
        "elapsed_time"
    ] == 10
    assert [
        row["elapsed_time"]
        for row in repo.fetch_all(
            "SELECT elapsed_time FROM player_life_events ORDER BY elapsed_time"
        )
    ] == [12, 20]


def test_telemetry_parser_links_attack_to_victim_by_attack_id(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    attacker = {
        "accountId": "account-1",
        "name": "PlayerOne",
        "teamId": 101,
        "location": {"x": 1000, "y": 2000},
    }
    victim = {
        "accountId": "account-2",
        "name": "PlayerTwo",
        "teamId": 102,
        "location": {"x": 4000, "y": 5000},
    }
    events = [
        {"_T": "LogMatchStart", "_D": "2026-06-05T00:00:00Z"},
        {
            "_T": "LogPlayerAttack",
            "_D": "2026-06-05T00:00:59Z",
            "attackId": 41,
            "attacker": attacker,
            "weapon": {"itemId": "Item_Weapon_AUG_C"},
        },
        {
            "_T": "LogPlayerAttack",
            "_D": "2026-06-05T00:01:00Z",
            "attackId": 42,
            "attacker": attacker,
            "weapon": {"itemId": "Item_Weapon_AUG_C"},
        },
        {
            "_T": "LogPlayerAttack",
            "_D": "2026-06-05T00:01:10Z",
            "attackId": 43,
            "attacker": attacker,
            "weapon": {"itemId": "Item_Weapon_AUG_C"},
        },
        {
            "_T": "LogPlayerTakeDamage",
            "_D": "2026-06-05T00:01:02.500Z",
            "attackId": 42,
            "attacker": attacker,
            "victim": victim,
            "damage": 24,
            "damageCauserName": "WeapAUG_C",
            "damageReason": "TorsoShot",
        },
    ]

    result = TelemetryParser(migrated_connection).parse_match("match-1", events)

    repo = SQLiteRepository(migrated_connection)
    attacks = repo.fetch_all(
        """
        SELECT
            elapsed_time,
            actor_player_id,
            victim_player_id,
            x,
            y,
            damage,
            damage_causer_name,
            damage_reason
        FROM player_life_events
        WHERE event_type = 'LogPlayerAttack'
        ORDER BY elapsed_time
        """
    )
    assert result.life_event_count == 3
    assert len(attacks) == 2
    assert [event["elapsed_time"] for event in attacks] == [59, 60]
    assert all(event["actor_player_id"] == "account-1" for event in attacks)
    assert all(event["victim_player_id"] == "account-2" for event in attacks)
    assert all(event["x"] == 1000 for event in attacks)
    assert all(event["y"] == 2000 for event in attacks)
    assert all(event["damage"] is None for event in attacks)
    assert all(event["damage_causer_name"] == "WeapAUG_C" for event in attacks)
    assert attacks[0]["damage_reason"] is None
    assert attacks[1]["damage_reason"] == "TorsoShot"


def test_telemetry_parser_backfills_existing_life_event_damage(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    events = [
        {"_T": "LogMatchStart", "_D": "2026-06-05T00:00:00Z", "common": {"isGame": 0}},
        {
            "_T": "LogPlayerTakeDamage",
            "_D": "2026-06-05T00:04:30Z",
            "common": {"isGame": 2},
            "attacker": {
                "accountId": "account-1",
                "name": "PlayerOne",
                "teamId": 101,
                "location": {"x": 2050, "y": 3050},
            },
            "victim": {
                "accountId": "account-2",
                "name": "PlayerTwo",
                "teamId": 102,
                "location": {"x": 2100, "y": 3100},
            },
            "damage": 18.75,
            "damageCauserName": "WeapM416_C",
            "damageReason": "TorsoShot",
        },
    ]
    repo = SQLiteRepository(migrated_connection)
    repo.insert_or_ignore(
        "player_life_events",
        {
            "match_id": "match-1",
            "elapsed_time": 270,
            "phase": None,
            "event_type": "LogPlayerTakeDamage",
            "actor_player_id": "account-1",
            "victim_player_id": "account-2",
            "x": 2100,
            "y": 3100,
            "damage": None,
        },
    )

    result = TelemetryParser(migrated_connection).parse_match("match-1", events)

    life_event = repo.fetch_one(
        "SELECT damage, damage_causer_name, damage_reason FROM player_life_events"
    )
    assert result.life_event_count == 0
    assert life_event["damage"] == 18.75
    assert life_event["damage_causer_name"] == "WeapM416_C"
    assert life_event["damage_reason"] == "TorsoShot"


def test_telemetry_parser_reads_nested_kill_damage_details(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    events = [
        {
            "_T": "LogPlayerKillV2",
            "common": {"isGame": 2, "elapsedTime": 270},
            "killer": {
                "accountId": "account-1",
                "name": "PlayerOne",
                "teamId": 101,
                "location": {"x": 2050, "y": 3050},
            },
            "victim": {
                "accountId": "account-2",
                "name": "PlayerTwo",
                "teamId": 102,
                "location": {"x": 2100, "y": 3100},
            },
            "killerDamageInfo": {
                "damageCauserName": "WeapKar98k_C",
                "damageReason": "HeadShot",
            },
        }
    ]

    TelemetryParser(migrated_connection).parse_match("match-1", events)

    event = SQLiteRepository(migrated_connection).fetch_one(
        "SELECT damage_causer_name, damage_reason FROM player_life_events"
    )
    assert event["damage_causer_name"] == "WeapKar98k_C"
    assert event["damage_reason"] == "HeadShot"


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


def test_telemetry_parser_can_replace_existing_timeline_rows(
    migrated_connection: sqlite3.Connection,
) -> None:
    _seed_match(migrated_connection)
    parser = TelemetryParser(migrated_connection)
    parser.parse_match("match-1", json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    replacement_events = [
        {
            "_T": "LogGameStatePeriodic",
            "common": {"isGame": 1},
            "gameState": {
                "elapsedTime": 70,
                "poisonGasWarningPosition": {"x": 420000, "y": 430000},
                "poisonGasWarningRadius": 300000,
            },
        },
        {
            "_T": "LogPlayerPosition",
            "common": {"isGame": 1, "elapsedTime": 71},
            "character": {
                "accountId": "account-1",
                "name": "PlayerOne",
                "teamId": 101,
                "health": 80,
                "location": {"x": 5000, "y": 6000},
            },
            "vehicle": None,
        },
        {
            "_T": "LogPlayerKillV2",
            "common": {"isGame": 1, "elapsedTime": 80},
            "killer": {"accountId": "account-1", "name": "PlayerOne", "teamId": 101},
            "victim": {"accountId": "account-2", "name": "PlayerTwo", "teamId": 102},
        },
    ]

    result = parser.parse_match("match-1", replacement_events, replace_existing=True)

    repo = SQLiteRepository(migrated_connection)
    assert result.circle_phase_count == 1
    assert result.position_sample_count == 1
    assert result.life_event_count == 1
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM circle_phases")["count"] == 1
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_position_samples")["count"] == 1
    assert repo.fetch_one("SELECT x FROM player_position_samples")["x"] == 5000
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_life_events")["count"] == 1
    assert repo.fetch_one("SELECT elapsed_time FROM player_life_events")["elapsed_time"] == 80


def test_telemetry_parser_rolls_back_failed_timeline_replacement(
    migrated_connection: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_match(migrated_connection)
    parser = TelemetryParser(migrated_connection)
    parser.parse_match("match-1", json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    replacement_events = [
        {
            "_T": "LogGameStatePeriodic",
            "common": {"isGame": 1},
            "gameState": {
                "elapsedTime": 70,
                "poisonGasWarningPosition": {"x": 420000, "y": 430000},
                "poisonGasWarningRadius": 300000,
            },
        }
    ]
    def fail_insert(*_args: object, **_kwargs: object) -> None:
        raise sqlite3.OperationalError("simulated insert failure")

    monkeypatch.setattr(parser.repo, "insert_or_ignore", fail_insert)

    with pytest.raises(sqlite3.OperationalError, match="simulated insert failure"):
        parser.parse_match("match-1", replacement_events, replace_existing=True)

    repo = SQLiteRepository(migrated_connection)
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM circle_phases")["count"] == 2
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_position_samples")["count"] == 2
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_life_events")["count"] == 1


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
