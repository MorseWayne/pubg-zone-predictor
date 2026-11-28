import os
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from app.db.connection import connect_database
from app.db.migrations import initialize_database

EXPECTED_MIGRATIONS = ["001", "002", "003", "004", "005", "006", "007", "008", "009", "010"]


# Collection imports the global ASGI app before ordinary fixtures run. Never let
# a developer's .env or a shell override point those tests at production data.
_session_store = TemporaryDirectory(prefix="pubg-backend-tests-")
for _name, _subpath in (
    ("APP_DATABASE_PATH", "test.sqlite3"),
    ("PUBG_TELEMETRY_CACHE_DIR", "telemetry"),
    ("PUBG_ASSETS_CACHE_DIR", "assets"),
    ("APP_MODEL_DIR", "models"),
    ("APP_DATA_DIR", ""),
):
    os.environ[_name] = str(Path(_session_store.name) / _subpath)
os.environ["PUBG_API_KEY"] = ""


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
