"""Explicitly triggered, local-only season recovery. No API client or download fallback."""

import json
import logging
import time
from collections import deque
from pathlib import Path
from threading import Event, Lock, Thread

from app.db.connection import database_connection
from app.services.seasons import definition_season
from app.services.telemetry_files import file_stamp

log = logging.getLogger(__name__)


def read_season(path: Path, stopped: Event) -> str | None:
    """Decode one array item at a time. Bound memory even for malformed cache files."""
    decoder = json.JSONDecoder()
    with path.open(encoding="utf-8-sig") as source:
        buf = source.read(65536).lstrip()
        if not buf.startswith("["):
            return None
        buf = buf[1:]
        while not stopped.is_set():
            buf = buf.lstrip()
            if buf.startswith(","):
                buf = buf[1:].lstrip()
            if buf.startswith("]"):
                return None
            try:
                event, end = decoder.raw_decode(buf)
            except ValueError:
                if len(buf) > 4 * 1024 * 1024 or not (chunk := source.read(65536)):
                    return None
                buf += chunk
            else:
                if season := definition_season(event):
                    return season
                buf = buf[end:]
    return None


class SeasonBackfill:
    def __init__(self, db_path: Path, cache_dir: Path):
        self.db_path, self.cache_dir = db_path, cache_dir
        self.lock = Lock()
        self.stop = Event()
        self.priority: dict[str, None] = {}
        self.thread: Thread | None = None
        self.next_sweep = 0.0

    def trigger(self, match_ids: list[str]) -> None:
        if not match_ids:
            return
        with self.lock:
            if self.stop.is_set():
                return
            self.priority.update(dict.fromkeys(match_ids))
            if self.thread is None:
                self.thread = Thread(target=self._run, name="season-backfill", daemon=True)
                self.thread.start()

    def _run(self) -> None:
        try:
            with database_connection(self.db_path) as db:
                rest = deque()
                if time.monotonic() >= self.next_sweep:
                    rest.extend(
                        r[0]
                        for r in db.execute(
                            "SELECT match_id FROM matches WHERE season_id IS NULL "
                            "ORDER BY created_at DESC"
                        )
                    )
                    self.next_sweep = time.monotonic() + 300
                seen = set()
                while not self.stop.is_set():
                    with self.lock:
                        if self.priority:
                            mid, _ = self.priority.popitem()
                        elif rest:
                            mid = rest.popleft()
                        else:
                            self.thread = None
                            return
                    if mid not in seen:
                        self._check(db, mid)
                        seen.add(mid)
        except Exception:
            log.exception("local season backfill stopped")
        with self.lock:
            self.thread = None

    def _check(self, db, mid: str) -> None:
        row = db.execute(
            """SELECT a.cache_path,c.file_fingerprint FROM matches m
            LEFT JOIN telemetry_assets a USING(match_id)
            LEFT JOIN match_season_backfill_checks c USING(match_id)
            WHERE m.match_id=? AND m.season_id IS NULL""",
            (mid,),
        ).fetchone()
        if not row:
            return
        paths = [Path(row[0])] if row[0] else []
        if Path(mid).name == mid:
            paths.append(self.cache_dir / f"{mid}.json")
        path = next((p for p in paths if p.is_file()), None)
        try:
            stamp = f"{path}:{file_stamp(path.stat())}" if path else "missing"
        except OSError:
            return  # file replaced between lookup and stat: retry next trigger
        if stamp == row[1]:
            return
        try:
            season = read_season(path, self.stop) if path else None
        except (ValueError, OSError, RecursionError):
            season = None
        if self.stop.is_set():
            return
        with db:
            if season:
                db.execute(
                    "UPDATE matches SET season_id=? WHERE match_id=? AND season_id IS NULL",
                    (season, mid),
                )
            else:
                db.execute(
                    "INSERT OR REPLACE INTO match_season_backfill_checks VALUES(?,?,?)",
                    (mid, stamp, time.time()),
                )

    def close(self) -> None:
        with self.lock:
            self.stop.set()
            thread = self.thread
        if thread:
            thread.join()
