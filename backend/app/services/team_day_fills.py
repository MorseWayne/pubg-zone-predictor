"""One bounded, cancellable worker per application. Never holds a main-DB tx over HTTP."""

import hashlib
import logging
import math
import time
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event, RLock, Thread
from uuid import uuid4

from app.core.errors import AppError
from app.db.connection import database_connection
from app.services.opponents import season_modes, season_resource
from app.services.team_day_intensity import ProfileKey, read_day, shared_days

BUDGET = 25
LIVE = {"queued", "running", "paused"}
log = logging.getLogger(__name__)


def plan_cache(client, keys):
    """Split missing snapshot keys into free promotions, cached absences, and real misses."""
    by_resource = defaultdict(list)
    for k in sorted(keys):
        _, pid, season, mode, ranked = k
        by_resource[season_resource(season, mode, ranked)].append(k)
    promote, misses = {}, set()
    for resource, group in by_resource.items():
        stamped = client.cache.read_stamped(resource, {k[1] for k in group}) if client.cache else {}
        for k in group:
            if k[1] not in stamped:
                misses.add(k)
                continue
            modes, observed, negative = stamped[k[1]]
            entry = modes.get(k[3]) if modes and not negative else None
            if (
                entry
                and entry.get("rounds", 0) > 0
                and (entry.get("kd") is not None or entry.get("adr") is not None)
            ):
                promote[k] = (observed, entry["rounds"], entry.get("kd"), entry.get("adr"))
    return promote, misses


def batches(keys):
    # Ranked response contains all modes, normal response contains one mode for <=10 accounts.
    groups = defaultdict(lambda: defaultdict(set))
    # Insert each account at its most recent encounter; one fetch still covers its older days.
    for key in sorted(keys, reverse=True):
        _, pid, season, mode, ranked = key
        groups[season, None if ranked else mode, ranked][pid].add(key)
    pending = []
    for (_, _, ranked), players in groups.items():
        size = 1 if ranked else 10
        accounts = list(players.values())
        for i in range(0, len(accounts), size):
            pending.append(set.union(*accounts[i : i + size]))
    # Interleave resources as well: exhausting the budget in one group must not starve recent days.
    yield from sorted(pending, key=lambda batch: max(k[0] for k in batch), reverse=True)


def scope_key(players, dates, random, min_members):
    return tuple(sorted(players)), tuple(sorted(set(dates))), bool(random), min_members


def fetch_days(db, players, dates, random, min_members):
    days = shared_days(db, players, min_members)
    return {
        d: read_day(db, players, random, d, days[d], min_members) for d in set(dates) if d in days
    }


def freeze(db, values, players, random, min_members):
    changed = set()
    inserted = 0
    with db:
        for key, stats in values.items():
            if db.execute(
                """INSERT INTO opponent_season_day_snapshots VALUES(?,?,?,?,?,?,?,?,?)
                           ON CONFLICT DO NOTHING""",
                (*key, *stats),
            ).rowcount:
                changed.add(key[0])
                inserted += 1
    if changed:
        fetch_days(db, players, changed, random, min_members)
    return inserted


@dataclass
class Job:
    scope: tuple
    job_id: str | None = None
    state: str = "queued"
    promoted: int = 0
    remaining: int = 0
    requests_used: int = 0
    revision: int = 0
    retry_until: float = 0
    stop: Event = field(default_factory=Event)

    def public(self):
        return dict(
            job_id=self.job_id,
            state=self.state,
            promoted=self.promoted,
            remaining=self.remaining,
            requests_used=self.requests_used,
            request_budget=BUDGET,
            revision=self.revision,
            retry_after=max(0, math.ceil(self.retry_until - time.monotonic())),
        )


class TeamDayFills:
    def __init__(self, database_path: Path, *, enabled=True):
        self.path = database_path
        self.enabled = enabled
        self.jobs = OrderedDict()
        self.lock = RLock()
        self.thread = None
        self.closed = False
        self.rejected_key = None

    def active(self, scope=None):
        with self.lock:
            return next(
                (
                    j.public()
                    for j in reversed(self.jobs.values())
                    if j.state in LIVE and (scope is None or j.scope == scope)
                ),
                None,
            )

    def get(self, jid, *, cancel=False):
        with self.lock:
            if jid not in self.jobs:
                raise AppError("FILL_NOT_FOUND", "找不到这次补齐任务。", 404)
            job = self.jobs[jid]
            if cancel and job.state in LIVE:
                job.stop.set()
            return job.public()

    def ensure(self, db, client, players, dates, random, min_members, manual=False):
        scope = scope_key(players, dates, random, min_members)
        days = fetch_days(db, players, dates, random, min_members)
        keys = {k for d in days.values() for k in d.missing}
        cached, misses = plan_cache(client, keys)
        promoted = freeze(db, cached, players, random, min_members)
        api_key = hashlib.sha256(client.api_key.encode()).digest() if client.api_key else None
        with self.lock:
            temp = Job(
                scope,
                promoted=promoted,
                revision=int(promoted > 0),
                remaining=len(keys) - len(cached),
            )
            if not temp.remaining:
                temp.state = "completed"
            elif not api_key:
                temp.state = "no_api_key"
            elif existing := self.active(scope):
                return existing
            elif not misses:
                temp.state = "completed"
            elif not self.enabled or self.closed:
                temp.state = "disabled"
            elif self.rejected_key == api_key:
                temp.state = "auth_error"
            elif self.active():
                temp.state = "busy"
            else:
                # Polling or remounting a view must not mint another automatic budget.
                previous = next((j for j in reversed(self.jobs.values()) if j.scope == scope), None)
                if (
                    previous
                    and not manual
                    and previous.state in {"budget_exhausted", "cancelled", "failed"}
                ):
                    return previous.public()
                temp.job_id = uuid4().hex
                if len(self.jobs) >= 64:
                    self.jobs.popitem(last=False)
                self.jobs[temp.job_id] = temp
                self.thread = Thread(
                    target=self._run,
                    args=(temp, client, misses, api_key),
                    name="team-day-fill",
                    daemon=True,
                )
                self.thread.start()
            return temp.public()

    def _fetch_batch(self, job, client, batch, api_key):
        # Recheck after acquiring the same lock as foreground authenticated reads.
        # Cancel while queued without making one last unwanted upstream call.
        cache = client.cache
        if cache:
            while not cache.fill_lock.acquire(timeout=0.1):
                if job.stop.is_set():
                    return {}
        try:
            values, missing = plan_cache(client, batch)
            if not missing or job.stop.is_set():
                return values
            if cache:
                quota = cache.read("quota", [api_key.hex()]).get(api_key.hex())
                if quota is not None:
                    raise AppError(
                        "PUBG_RATE_LIMIT",
                        "等待共享配额恢复",
                        429,
                        {"retry_after": math.ceil(quota - cache.clock())},
                    )
            with self.lock:
                if job.requests_used >= BUDGET:
                    job.state = "budget_exhausted"
                    return None
                job.requests_used += 1
            _, _, season, mode, ranked = min(missing)
            ids = sorted({k[1] for k in missing})
            result = season_modes(client, season, mode, bool(ranked), ids)
            if cache:
                return plan_cache(client, batch)[0]
            for key in missing:
                row = (result.get(key[1]) or {}).get(key[3])
                if row and (row["kd"] is not None or row["adr"] is not None):
                    values[key] = (time.time(), row["rounds"], row["kd"], row["adr"])
            return values
        finally:
            if cache:
                cache.fill_lock.release()

    def _run(self, job, client, keys: set[ProfileKey], api_key):
        players, _, random, min_members = job.scope
        try:
            with database_connection(self.path) as db:
                for batch in batches(keys):
                    while not job.stop.is_set():
                        with self.lock:
                            job.state = "running"
                        try:
                            values = self._fetch_batch(job, client, batch, api_key)
                            if values is None:
                                return
                        except AppError as exc:
                            if exc.status_code == 429:
                                delay = max(1, exc.details.get("retry_after", 60))
                                with self.lock:
                                    job.state = "paused"
                                    job.retry_until = time.monotonic() + delay
                                job.stop.wait(delay)
                                continue
                            if exc.details.get("upstream_status") in (401, 403):
                                with self.lock:
                                    self.rejected_key = api_key
                                    job.state = "auth_error"
                                return
                            raise
                        if job.stop.is_set():
                            break
                        count = freeze(db, values, players, random, min_members)
                        with self.lock:
                            job.promoted += count
                            job.remaining -= len(values)
                            job.revision += 1
                            job.retry_until = 0
                        break
                    if job.stop.is_set():
                        break
            with self.lock:
                job.state = "cancelled" if job.stop.is_set() else "completed"
                job.retry_until = 0
        except Exception:
            log.exception("team-day fill failed")
            with self.lock:
                job.state = "failed"

    def close(self):
        with self.lock:
            self.closed = True
            for job in self.jobs.values():
                job.stop.set()
            thread = self.thread
        if thread:
            thread.join()
