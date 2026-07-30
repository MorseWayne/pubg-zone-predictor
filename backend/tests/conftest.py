import sqlite3
from pathlib import Path

import pytest
from app.db.connection import connect_database
from app.db.migrations import initialize_database

EXPECTED_MIGRATIONS = ["001", "002", "003", "004", "005", "006", "007", "008"]


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "test.sqlite3"


@pytest.fixture
def migrated_connection(database_path: Path) -> sqlite3.Connection:
    applied = initialize_database(database_path)
    assert [migration.version for migration in applied] == EXPECTED_MIGRATIONS

    connection = connect_database(database_path)
    try:
        yield connection
    finally:
        connection.close()
