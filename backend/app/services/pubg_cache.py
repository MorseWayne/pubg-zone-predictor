"""On-disk cache for PUBG reads. Each SQLite transaction ends before accessing the network."""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable, Iterable
from contextlib import closing
from pathlib import Path
from threading import Lock, RLock
from typing import Any

from app.core.errors import AppError

PLAYER_TTL = 10 * 60
SEASON_TTL = 6 * 3600
MASTERY_TTL = 24 * 3600
MATCH_TTL = 14 * 24 * 3600
ABSENT_TTL = 5 * 60


class PubgCache:
    def __init__(self, path: Path, origin: str, clock: Callable[[], float] = time.time):
        self.path = path
        self.origin = origin.rstrip("/")
        self.clock = clock
        # All authenticated misses for this local server share a quota. Cache hits
        # and match/telemetry downloads do not wait for an authenticated request.
        self.fill_lock = RLock()
        self.match_locks = [RLock() for _ in range(32)]
        self._initialized = False
        self._schema_lock = Lock()

    def _initialize_for_write(self) -> None:
        if self._initialized:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS entries (
                    origin TEXT NOT NULL, resource TEXT NOT NULL, id TEXT NOT NULL,
                    updated REAL NOT NULL, expires REAL NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(origin, resource, id)
                ) WITHOUT ROWID;
                CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires);
            """)

        self._initialized = True

    def read_stamped(
        self, resource: str, ids: Iterable[str], *, since: float = -float("inf")
    ) -> dict[str, tuple[Any, float, bool]]:
        if not self.path.is_file():
            return {}
        uri = self.path.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as db:
            if not db.execute("SELECT 1 FROM sqlite_schema WHERE name='entries'").fetchone():
                return {}
            rows = db.execute(
                """
                SELECT id, payload, updated FROM entries WHERE origin=? AND resource=? AND expires>?
                    AND updated > ? AND id IN (SELECT value FROM json_each(?))
            """,
                (self.origin, resource, self.clock(), since, json.dumps(list(ids))),
            )
            return {
                key: (value, updated, not value)
                for key, payload, updated in rows
                for value in [json.loads(payload)]
            }

    def read(self, resource: str, ids: Iterable[str], *, since: float = -float("inf")) -> dict:
        return {k: v[0] for k, v in self.read_stamped(resource, ids, since=since).items()}

    def write(self, resource: str, values: dict, ttl: float) -> None:
        now = self.clock()
        with self._schema_lock:
            self._initialize_for_write()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("DELETE FROM entries WHERE expires <= ?", (now,))
            db.executemany(
                """
                INSERT INTO entries(origin,resource,id,updated,expires,payload) VALUES(?,?,?,?,?,?)
                ON CONFLICT(origin,resource,id) DO UPDATE
                SET updated=excluded.updated, expires=excluded.expires, payload=excluded.payload
            """,
                [
                    (
                        self.origin,
                        resource,
                        key,
                        now,
                        now + (ttl if value else ABSENT_TTL),
                        json.dumps(value, ensure_ascii=False),
                    )
                    for key, value in values.items()
                ],
            )

    def forget(self, resource: str, key: str) -> None:
        if not self.path.is_file():
            return
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute(
                "DELETE FROM entries WHERE origin=? AND resource=? AND id=?",
                (self.origin, resource, key),
            )

    def resolve(
        self,
        resource: str,
        ids: list[str],
        ttl: int,
        fetch: Callable[[list[str]], dict],
        *,
        force: bool = False,
    ) -> dict:
        unique = list(dict.fromkeys(ids))
        started = self.clock() if force else -float("inf")
        if not force:
            found = self.read(resource, unique)
            if len(found) == len(unique):
                return found
        with self.fill_lock:
            found = self.read(resource, unique, since=started)
            missing = [key for key in unique if key not in found]
            if missing:
                try:
                    fetched = fetch(missing)
                except AppError as exc:
                    if exc.details.get("upstream_status") != 404:
                        raise
                    # A batch-level 404 cannot establish which individual accounts are absent.
                    if len(missing) > 1:
                        return {**found, **dict.fromkeys(missing)}
                    fetched = {}
                values = {key: fetched.get(key) for key in missing}
                self.write(resource, values, ttl)
                found.update(values)
            return found
