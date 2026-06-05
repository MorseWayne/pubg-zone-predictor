import sqlite3

import pytest
from app.db.repository import SQLiteRepository


def test_insert_or_ignore_uses_unique_keys(migrated_connection: sqlite3.Connection) -> None:
    repo = SQLiteRepository(migrated_connection)

    first = repo.insert_or_ignore(
        "tournaments",
        {
            "id": "tournament-1",
            "type": "official",
            "created_at": "2026-06-05T00:00:00Z",
            "source": "test",
        },
    )
    second = repo.insert_or_ignore(
        "tournaments",
        {
            "id": "tournament-1",
            "type": "official",
            "created_at": "2026-06-05T00:00:00Z",
            "source": "test",
        },
    )

    assert first.rowcount == 1
    assert second.rowcount == 0
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM tournaments")["count"] == 1


def test_upsert_updates_existing_row(migrated_connection: sqlite3.Connection) -> None:
    repo = SQLiteRepository(migrated_connection)

    repo.upsert(
        "tournaments",
        {
            "id": "tournament-1",
            "type": "official",
            "created_at": "2026-06-05T00:00:00Z",
            "source": "initial",
        },
        conflict_columns=("id",),
    )
    result = repo.upsert(
        "tournaments",
        {
            "id": "tournament-1",
            "type": "official",
            "created_at": "2026-06-05T00:00:00Z",
            "source": "updated",
        },
        conflict_columns=("id",),
    )

    row = repo.fetch_one("SELECT source FROM tournaments WHERE id = ?", ("tournament-1",))

    assert result.rowcount == 1
    assert row["source"] == "updated"


def test_training_sample_uniqueness_and_roster_foreign_keys(
    migrated_connection: sqlite3.Connection,
) -> None:
    repo = SQLiteRepository(migrated_connection)
    repo.insert_or_ignore("tournaments", {"id": "tournament-1", "type": "official"})
    repo.insert_or_ignore(
        "matches",
        {
            "match_id": "match-1",
            "tournament_id": "tournament-1",
            "map_name": "Erangel_Main",
        },
    )
    repo.insert_or_ignore(
        "match_teams",
        {"match_id": "match-1", "team_id": "team-1", "is_unknown": 0},
    )
    repo.insert_or_ignore(
        "match_rosters",
        {
            "match_id": "match-1",
            "team_id": "team-1",
            "player_id": "player-1",
            "player_name": "Player One",
        },
    )

    first = repo.insert_or_ignore(
        "player_position_samples",
        {
            "match_id": "match-1",
            "player_id": "player-1",
            "team_id": "team-1",
            "phase": 3,
            "elapsed_time": 125.2,
            "elapsed_time_bucket": 125,
            "x": 100.0,
            "y": 200.0,
            "alive": 1,
        },
    )
    duplicate = repo.insert_or_ignore(
        "player_position_samples",
        {
            "match_id": "match-1",
            "player_id": "player-1",
            "team_id": "team-1",
            "phase": 3,
            "elapsed_time": 126.0,
            "elapsed_time_bucket": 125,
            "x": 120.0,
            "y": 220.0,
            "alive": 1,
        },
    )

    with pytest.raises(sqlite3.IntegrityError):
        repo.insert_or_ignore(
            "player_position_samples",
            {
                "match_id": "match-1",
                "player_id": "missing-player",
                "team_id": "team-1",
                "phase": 3,
                "elapsed_time": 130.0,
                "elapsed_time_bucket": 130,
                "x": 100.0,
                "y": 200.0,
            },
        )

    assert first.rowcount == 1
    assert duplicate.rowcount == 0
    assert repo.fetch_one("SELECT COUNT(*) AS count FROM player_position_samples")["count"] == 1
