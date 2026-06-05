import sqlite3
from dataclasses import dataclass
from pathlib import Path

from app.db.connection import connect_database

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    path: Path


class MigrationError(RuntimeError):
    pass


def discover_migrations(migrations_dir: Path = MIGRATIONS_DIR) -> list[Migration]:
    migrations: list[Migration] = []
    for path in sorted(migrations_dir.glob("*.sql")):
        version, _, name = path.stem.partition("_")
        if not version.isdigit() or not name:
            raise MigrationError(f"Invalid migration filename: {path.name}")
        migrations.append(Migration(version=version, name=name, path=path))
    return migrations


def initialize_database(database_path: Path | str | None = None) -> list[Migration]:
    connection = connect_database(database_path)
    try:
        return apply_migrations(connection)
    finally:
        connection.close()


def apply_migrations(connection: sqlite3.Connection) -> list[Migration]:
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    applied_versions = {
        row["version"]
        for row in connection.execute("SELECT version FROM schema_migrations").fetchall()
    }

    applied: list[Migration] = []
    for migration in discover_migrations():
        if migration.version in applied_versions:
            continue

        script = migration.path.read_text(encoding="utf-8")
        try:
            connection.executescript(script)
            connection.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
                (migration.version, migration.name),
            )
        except sqlite3.DatabaseError as exc:
            connection.rollback()
            raise MigrationError(f"Failed to apply migration {migration.path.name}") from exc
        else:
            connection.commit()
            applied.append(migration)

    return applied
