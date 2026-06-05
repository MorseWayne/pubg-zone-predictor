import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from app.core.config import get_settings


def resolve_database_path(database_path: Path | str | None = None) -> Path | str:
    if database_path is not None:
        return database_path
    return get_settings().database_path


def connect_database(database_path: Path | str | None = None) -> sqlite3.Connection:
    resolved_path = resolve_database_path(database_path)
    if isinstance(resolved_path, Path):
        resolved_path.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(resolved_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    if resolved_path != ":memory:":
        connection.execute("PRAGMA journal_mode = WAL")
    return connection


@contextmanager
def database_connection(database_path: Path | str | None = None) -> Iterator[sqlite3.Connection]:
    connection = connect_database(database_path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
