"""On-disk cache for PUBG reads. Each SQLite transaction ends before accessing the network."""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable, Iterable
from contextlib import closing
from pathlib import Path
from threading import RLock
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
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS entries (
                    origin TEXT NOT NULL, resource TEXT NOT NULL, id TEXT NOT NULL,
                    updated REAL NOT NULL, expires REAL NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(origin, resource, id)
                ) WITHOUT ROWID;
                CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires);
            """)

    def read(
        self, resource: str, ids: Iterable[str], *, since: float = -float("inf")
    ) -> dict[str, Any]:
        with closing(sqlite3.connect(self.path)) as db:
            rows = db.execute(
                """
                SELECT id, payload FROM entries WHERE origin=? AND resource=? AND expires>?
                    AND updated > ? AND id IN (SELECT value FROM json_each(?))
            """,
                (self.origin, resource, self.clock(), since, json.dumps(list(ids))),
            )
            return {key: json.loads(payload) for key, payload in rows}

    def write(self, resource: str, values: dict, ttl: float) -> None:
        now = self.clock()
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
