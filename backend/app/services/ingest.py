from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.pubg_api import PubgApiClient
from app.services.telemetry_parser import (
    PARSE_PROFILE_FULL,
    PARSE_PROFILE_HOTSPOT_LIGHT,
    PARSE_PROFILES,
    TelemetryParser,
)

TERMINAL_JOB_STATUSES = {"completed", "failed", "cancelled"}
DEFAULT_SAMPLE_PLATFORM = "steam"
DEFAULT_SAMPLE_GAME_MODE = "squad"
DEFAULT_SAMPLE_PARSE_PROFILE = PARSE_PROFILE_HOTSPOT_LIGHT
DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS = 30
EXCLUDED_SAMPLE_MATCH_TYPES = {"custom", "competitive"}
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IngestJobResult:
    id: str
    job_type: str
    status: str
    source_ref: str | None
    total_count: int
    success_count: int
    skipped_count: int
    failed_count: int
    retry_count: int
    started_at: str | None
    finished_at: str | None
    error_code: str | None
    error_message: str | None
    warnings: list[str] = field(default_factory=list)


@dataclass
class IngestService:
    connection: sqlite3.Connection
    pubg_client: PubgApiClient
    telemetry_cache_dir: Path

    def __post_init__(self) -> None:
        self.repo = SQLiteRepository(self.connection)

    def ingest_tournaments(self, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("tournament_list", "pubg-api", retry_count=retry_count)
        try:
            payload = self.pubg_client.get_tournaments()
            tournaments = self._data_list(payload)
            stats = _empty_stats(total_count=len(tournaments))
            warnings: list[str] = []

            for tournament in tournaments:
                tournament_id = tournament.get("id")
                if not tournament_id:
                    stats["skipped_count"] += 1
                    warnings.append("skipped tournament without id")
                    continue
                attributes = self._attributes(tournament)
                self.repo.upsert(
                    "tournaments",
                    {
                        "id": tournament_id,
                        "type": tournament.get("type", "tournament"),
                        "created_at": attributes.get("createdAt"),
                        "source": "pubg_api",
                    },
                    conflict_columns=("id",),
                )
                stats["success_count"] += 1

            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def ingest_tournament(self, tournament_id: str, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("tournament_matches", tournament_id, retry_count=retry_count)
        warnings: list[str] = []
        try:
            payload = self.pubg_client.get_tournament(tournament_id)
            tournament = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
            attributes = self._attributes(tournament)
            self.repo.upsert(
                "tournaments",
                {
                    "id": tournament_id,
                    "type": tournament.get("type", "tournament"),
                    "created_at": attributes.get("createdAt"),
                    "source": "pubg_api",
                },
                conflict_columns=("id",),
            )

            match_refs = self._match_refs(tournament)
            stats = _empty_stats(total_count=len(match_refs))
            for match_id in match_refs:
                try:
                    match_payload = self.pubg_client.get_tournament_match(match_id)
                    match_values, telemetry_url = self._match_values(
                        match_id,
                        tournament_id,
                        match_payload,
                    )
                    self.repo.upsert("matches", match_values, conflict_columns=("match_id",))
                    if not telemetry_url:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' has no telemetry URL")
                        continue

                    cache_path = self._cache_match_telemetry(match_id, telemetry_url)
                    parse_result = self._parse_cached_match_telemetry(match_id, cache_path)
                    _log_parse_warnings(match_id, parse_result.warnings)
                    stats["success_count"] += 1
                except AppError as exc:
                    stats["failed_count"] += 1
                    warnings.append(f"match '{match_id}' failed: {exc.message}")

            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def ingest_sample_matches(
        self,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        retry_count: int = 0,
    ) -> IngestJobResult:
        job = self.start_sample_matches(
            platform=platform,
            game_mode=game_mode,
            max_matches=max_matches,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
            retry_count=retry_count,
        )
        self.run_sample_matches_job(
            job.id,
            platform=platform,
            game_mode=game_mode,
            max_matches=max_matches,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
        )
        return self.get_job(job.id)

    def start_sample_matches(
        self,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        retry_count: int = 0,
    ) -> IngestJobResult:
        _validate_parse_options(parse_profile, position_interval_seconds)
        source_ref = _sample_source_ref(
            platform,
            game_mode,
            max_matches=max_matches,
            parse_profile=parse_profile,
            position_interval_seconds=position_interval_seconds,
        )
        job_id = self._create_job("sample_matches", source_ref, retry_count=retry_count)
        return IngestJobResult(
            id=job_id,
            job_type="sample_matches",
            status="running",
            source_ref=source_ref,
            total_count=0,
            success_count=0,
            skipped_count=0,
            failed_count=0,
            retry_count=retry_count,
            started_at=_utc_now(),
            finished_at=None,
            error_code=None,
            error_message=None,
            warnings=[],
        )

    def run_sample_matches_job(
        self,
        job_id: str,
        *,
        platform: str = DEFAULT_SAMPLE_PLATFORM,
        game_mode: str = DEFAULT_SAMPLE_GAME_MODE,
        max_matches: int | None = None,
        parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
        position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
    ) -> None:
        _validate_parse_options(parse_profile, position_interval_seconds)
        warnings: list[str] = []
        try:
            payload = self.pubg_client.get_match_samples(platform)
            match_refs = self._sample_match_refs(payload)
            if max_matches is not None:
                match_refs = match_refs[:max_matches]
            stats = _empty_stats(total_count=len(match_refs))
            self._update_job_progress(job_id, stats, warnings=warnings)

            for match_id in match_refs:
                if self._is_job_cancelled(job_id):
                    return
                try:
                    match_payload = self.pubg_client.get_match(match_id, platform)
                    match_values, telemetry_url = self._match_values(
                        match_id,
                        None,
                        match_payload,
                    )
                    attributes = self._match_attributes(match_payload)
                    match_game_mode = attributes.get("gameMode")
                    match_type = attributes.get("matchType")
                    if match_game_mode != game_mode:
                        stats["skipped_count"] += 1
                        warnings.append(
                            f"match '{match_id}' skipped: gameMode is '{match_game_mode}'"
                        )
                        continue
                    if isinstance(match_type, str) and match_type in EXCLUDED_SAMPLE_MATCH_TYPES:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' skipped: matchType is '{match_type}'")
                        continue

                    self.repo.upsert("matches", match_values, conflict_columns=("match_id",))
                    if not telemetry_url:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' has no telemetry URL")
                        continue

                    cache_path = self._cache_match_telemetry(match_id, telemetry_url)
                    parse_result = self._parse_cached_match_telemetry(
                        match_id,
                        cache_path,
                        parse_profile=parse_profile,
                        position_interval_seconds=position_interval_seconds,
                    )
                    _log_parse_warnings(match_id, parse_result.warnings)
                    stats["success_count"] += 1
                except AppError as exc:
                    stats["failed_count"] += 1
                    warnings.append(f"match '{match_id}' failed: {exc.message}")
                finally:
                    self._update_job_progress(job_id, stats, warnings=warnings)
                    if self._is_job_cancelled(job_id):
                        return

            if self._is_job_cancelled(job_id):
                return
            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)

    def download_match_telemetry(self, match_id: str, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("telemetry_download", match_id, retry_count=retry_count)
        try:
            asset = self.repo.fetch_one(
                "SELECT telemetry_url FROM telemetry_assets WHERE match_id = ?",
                (match_id,),
            )
            if asset is None:
                raise AppError(
                    code="TELEMETRY_ASSET_NOT_FOUND",
                    message=f"telemetry URL is not known for match '{match_id}'",
                    status_code=404,
                    details={"match_id": match_id},
                )

            self._cache_match_telemetry(match_id, asset["telemetry_url"])
            self._complete_job(
                job_id,
                {"total_count": 1, "success_count": 1, "skipped_count": 0, "failed_count": 0},
            )
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def parse_match_telemetry(self, match_id: str, *, retry_count: int = 0) -> IngestJobResult:
        job_id = self._create_job("telemetry_parse", match_id, retry_count=retry_count)
        try:
            asset = self.repo.fetch_one(
                "SELECT cache_path FROM telemetry_assets WHERE match_id = ?",
                (match_id,),
            )
            if asset is None or not asset["cache_path"]:
                raise AppError(
                    code="TELEMETRY_CACHE_NOT_FOUND",
                    message=f"telemetry cache is not known for match '{match_id}'",
                    status_code=404,
                    details={"match_id": match_id},
                )

            cache_path = Path(asset["cache_path"])
            if not cache_path.exists():
                raise AppError(
                    code="TELEMETRY_CACHE_NOT_FOUND",
                    message=f"telemetry cache file was not found for match '{match_id}'",
                    status_code=404,
                    details={"match_id": match_id, "cache_path": str(cache_path)},
                )

            parse_result = self._parse_cached_match_telemetry(match_id, cache_path)
            _log_parse_warnings(match_id, parse_result.warnings)
            parsed_count = self._parsed_row_count(match_id)
            self._complete_job(
                job_id,
                {
                    "total_count": parse_result.event_count,
                    "success_count": parsed_count,
                    "skipped_count": len(parse_result.warnings),
                    "failed_count": 0,
                },
            )
        except AppError as exc:
            self.repo.execute(
                """
                UPDATE telemetry_assets
                SET parse_status = 'failed',
                    error_message = ?
                WHERE match_id = ?
                """,
                (exc.message, match_id),
            )
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

    def _cache_match_telemetry(self, match_id: str, telemetry_url: str) -> Path:
        content = self.pubg_client.download_telemetry(telemetry_url)
        content_hash = hashlib.sha256(content).hexdigest()
        cache_path = self.telemetry_cache_dir / f"{match_id}.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(content)
        self.repo.upsert(
            "telemetry_assets",
            {
                "match_id": match_id,
                "telemetry_url": telemetry_url,
                "cache_path": str(cache_path),
                "content_hash": content_hash,
                "downloaded_at": _utc_now(),
                "parse_status": "pending",
            },
            conflict_columns=("match_id",),
        )
        return cache_path

    def _parse_cached_match_telemetry(
        self,
        match_id: str,
        cache_path: Path,
        *,
        parse_profile: str = PARSE_PROFILE_FULL,
        position_interval_seconds: int = 5,
    ) -> Any:
        events = _read_telemetry_events(cache_path)
        parse_result = TelemetryParser(
            self.connection,
            sample_interval_seconds=position_interval_seconds,
            parse_profile=parse_profile,
        ).parse_match(match_id, events)
        self.repo.execute(
            """
            UPDATE telemetry_assets
            SET parse_status = 'completed',
                error_message = ?
            WHERE match_id = ?
            """,
            (
                json.dumps(parse_result.warnings, ensure_ascii=False)
                if parse_result.warnings
                else None,
                match_id,
            ),
        )
        return parse_result

    def _parsed_row_count(self, match_id: str) -> int:
        row = self.repo.fetch_one(
            """
            SELECT
                (SELECT COUNT(*) FROM circle_phases WHERE match_id = ?) +
                (SELECT COUNT(*) FROM player_position_samples WHERE match_id = ?) +
                (SELECT COUNT(*) FROM player_life_events WHERE match_id = ?) AS count
            """,
            (match_id, match_id, match_id),
        )
        return int(row["count"] if row else 0)

    def get_job(self, job_id: str) -> IngestJobResult:
        row = self.repo.fetch_one("SELECT * FROM ingest_jobs WHERE id = ?", (job_id,))
        if row is None:
            raise AppError(
                code="INGEST_JOB_NOT_FOUND",
                message=f"ingest job '{job_id}' was not found",
                status_code=404,
                details={"job_id": job_id},
            )
        return self._job_result(row)

    def retry_job(self, job_id: str) -> IngestJobResult:
        job = self.get_job(job_id)
        next_retry_count = job.retry_count + 1
        if job.job_type == "tournament_list":
            return self.ingest_tournaments(retry_count=next_retry_count)
        if job.job_type == "tournament_matches" and job.source_ref:
            return self.ingest_tournament(job.source_ref, retry_count=next_retry_count)
        if job.job_type == "sample_matches" and job.source_ref:
            platform, game_mode, max_matches, parse_profile, position_interval_seconds = (
                _sample_source_ref_parts(job.source_ref)
            )
            return self.ingest_sample_matches(
                platform=platform,
                game_mode=game_mode,
                max_matches=max_matches,
                parse_profile=parse_profile,
                position_interval_seconds=position_interval_seconds,
                retry_count=next_retry_count,
            )
        if job.job_type == "telemetry_download" and job.source_ref:
            return self.download_match_telemetry(job.source_ref, retry_count=next_retry_count)
        if job.job_type == "telemetry_parse" and job.source_ref:
            return self.parse_match_telemetry(job.source_ref, retry_count=next_retry_count)
        raise AppError(
            code="INGEST_JOB_NOT_RETRYABLE",
            message=f"ingest job '{job_id}' cannot be retried",
            details={"job_id": job_id, "job_type": job.job_type},
        )

    def cancel_job(self, job_id: str) -> IngestJobResult:
        job = self.get_job(job_id)
        if job.status in TERMINAL_JOB_STATUSES:
            return job
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'cancelled',
                finished_at = ?,
                error_code = NULL,
                error_message = NULL
            WHERE id = ? AND status = 'running'
            """,
            (_utc_now(), job_id),
        )
        self.connection.commit()
        return self.get_job(job_id)

    def _create_job(self, job_type: str, source_ref: str | None, *, retry_count: int = 0) -> str:
        job_id = f"job_{uuid4().hex}"
        started_at = _utc_now()
        try:
            self.repo.execute(
                """
                INSERT INTO ingest_jobs (
                    id,
                    job_type,
                    status,
                    source_ref,
                    retry_count,
                    started_at
                )
                VALUES (?, ?, 'running', ?, ?, ?)
                """,
                (job_id, job_type, source_ref, retry_count, started_at),
            )
        except sqlite3.IntegrityError as exc:
            raise AppError(
                code="INGEST_JOB_CREATE_FAILED",
                message=(
                    f"failed to create ingest job of type '{job_type}'. "
                    "Run database migrations and try again."
                ),
                status_code=500,
                details={"job_type": job_type, "source_ref": source_ref},
            ) from exc
        self.connection.commit()
        return job_id

    def _complete_job(
        self,
        job_id: str,
        stats: dict[str, int],
        *,
        warnings: list[str] | None = None,
    ) -> None:
        error_message = json.dumps(warnings, ensure_ascii=False) if warnings else None
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'completed',
                total_count = ?,
                success_count = ?,
                skipped_count = ?,
                failed_count = ?,
                finished_at = ?,
                error_code = NULL,
                error_message = ?
            WHERE id = ? AND status = 'running'
            """,
            (
                stats["total_count"],
                stats["success_count"],
                stats["skipped_count"],
                stats["failed_count"],
                _utc_now(),
                error_message,
                job_id,
            ),
        )
        self.connection.commit()

    def _update_job_progress(
        self,
        job_id: str,
        stats: dict[str, int],
        *,
        warnings: list[str] | None = None,
    ) -> None:
        error_message = json.dumps(warnings, ensure_ascii=False) if warnings else None
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'running',
                total_count = ?,
                success_count = ?,
                skipped_count = ?,
                failed_count = ?,
                error_message = ?
            WHERE id = ? AND status = 'running'
            """,
            (
                stats["total_count"],
                stats["success_count"],
                stats["skipped_count"],
                stats["failed_count"],
                error_message,
                job_id,
            ),
        )
        self.connection.commit()

    def _fail_job(self, job_id: str, error_code: str, error_message: str) -> None:
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'failed',
                failed_count = CASE WHEN total_count = 0 THEN 1 ELSE failed_count END,
                finished_at = ?,
                error_code = ?,
                error_message = ?
            WHERE id = ? AND status = 'running'
            """,
            (_utc_now(), error_code, error_message, job_id),
        )
        self.connection.commit()

    def _is_job_cancelled(self, job_id: str) -> bool:
        row = self.repo.fetch_one("SELECT status FROM ingest_jobs WHERE id = ?", (job_id,))
        return bool(row and row["status"] == "cancelled")

    @staticmethod
    def _data_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
        data = payload.get("data", [])
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    @staticmethod
    def _attributes(entity: dict[str, Any]) -> dict[str, Any]:
        attributes = entity.get("attributes", {})
        return attributes if isinstance(attributes, dict) else {}

    @staticmethod
    def _match_refs(tournament: dict[str, Any]) -> list[str]:
        relationships = tournament.get("relationships", {})
        matches = relationships.get("matches", {}) if isinstance(relationships, dict) else {}
        data = matches.get("data", []) if isinstance(matches, dict) else []
        return [item["id"] for item in data if isinstance(item, dict) and item.get("id")]

    @staticmethod
    def _sample_match_refs(payload: dict[str, Any]) -> list[str]:
        data = payload.get("data", {})
        sample_items = data if isinstance(data, list) else [data]
        match_ids: list[str] = []
        for sample in sample_items:
            if not isinstance(sample, dict):
                continue
            relationships = sample.get("relationships", {})
            matches = relationships.get("matches", {}) if isinstance(relationships, dict) else {}
            refs = matches.get("data", []) if isinstance(matches, dict) else []
            match_ids.extend(
                item["id"] for item in refs if isinstance(item, dict) and item.get("id")
            )
        return match_ids

    @staticmethod
    def _match_values(
        match_id: str,
        tournament_id: str | None,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], str | None]:
        match = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
        attributes = IngestService._match_attributes(payload)
        telemetry_url = IngestService._telemetry_url(payload)
        return (
            {
                "match_id": match.get("id", match_id),
                "tournament_id": tournament_id,
                "map_name": attributes.get("mapName") or "unknown",
                "shard_id": attributes.get("shardId"),
                "game_mode": attributes.get("gameMode"),
                "match_type": attributes.get("matchType"),
                "created_at": attributes.get("createdAt"),
                "duration": attributes.get("duration"),
                "telemetry_url": telemetry_url,
                "ingest_status": "completed" if telemetry_url else "skipped",
                "error_message": None if telemetry_url else "telemetry URL missing",
            },
            telemetry_url,
        )

    @staticmethod
    def _match_attributes(payload: dict[str, Any]) -> dict[str, Any]:
        match = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
        return IngestService._attributes(match)

    @staticmethod
    def _telemetry_url(payload: dict[str, Any]) -> str | None:
        included = payload.get("included", [])
        if not isinstance(included, list):
            return None
        for entity in included:
            if not isinstance(entity, dict):
                continue
            attributes = entity.get("attributes", {})
            if isinstance(attributes, dict) and attributes.get("URL"):
                return attributes["URL"]
        return None

    @staticmethod
    def _job_result(row: sqlite3.Row) -> IngestJobResult:
        warnings: list[str] = []
        if row["status"] != "failed" and row["error_message"]:
            try:
                decoded = json.loads(row["error_message"])
                warnings = decoded if isinstance(decoded, list) else [str(decoded)]
            except json.JSONDecodeError:
                warnings = [row["error_message"]]
        return IngestJobResult(
            id=row["id"],
            job_type=row["job_type"],
            status=row["status"],
            source_ref=row["source_ref"],
            total_count=row["total_count"],
            success_count=row["success_count"],
            skipped_count=row["skipped_count"],
            failed_count=row["failed_count"],
            retry_count=row["retry_count"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            error_code=row["error_code"],
            error_message=row["error_message"] if row["status"] == "failed" else None,
            warnings=warnings,
        )


def _read_telemetry_events(cache_path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AppError(
            code="TELEMETRY_CACHE_INVALID",
            message="telemetry cache file is not valid JSON",
            status_code=400,
            details={"cache_path": str(cache_path)},
        ) from exc
    if not isinstance(payload, list):
        raise AppError(
            code="TELEMETRY_FORMAT_INVALID",
            message="telemetry content must be a JSON array",
            status_code=400,
            details={"cache_path": str(cache_path)},
        )
    return payload


def _sample_source_ref(
    platform: str,
    game_mode: str,
    *,
    max_matches: int | None = None,
    parse_profile: str = DEFAULT_SAMPLE_PARSE_PROFILE,
    position_interval_seconds: int = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
) -> str:
    parts = [f"samples:{platform}:{game_mode}"]
    if max_matches is not None:
        parts.append(f"max={max_matches}")
    parts.append(f"profile={parse_profile}")
    parts.append(f"interval={position_interval_seconds}")
    return ":".join(parts)


def _sample_source_ref_parts(source_ref: str) -> tuple[str, str, int | None, str, int]:
    parts = source_ref.split(":")
    if len(parts) < 3 or parts[0] != "samples" or not parts[1] or not parts[2]:
        raise AppError(
            code="INGEST_JOB_SOURCE_REF_INVALID",
            message=f"sample ingest job source_ref '{source_ref}' is invalid",
            details={"source_ref": source_ref},
        )
    max_matches: int | None = None
    parse_profile = DEFAULT_SAMPLE_PARSE_PROFILE
    position_interval_seconds = DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS
    for option in parts[3:]:
        key, _, value = option.partition("=")
        if not key or not value:
            raise AppError(
                code="INGEST_JOB_SOURCE_REF_INVALID",
                message=f"sample ingest job source_ref '{source_ref}' is invalid",
                details={"source_ref": source_ref},
            )
        if key == "max":
            try:
                max_matches = int(value)
            except ValueError as exc:
                raise AppError(
                    code="INGEST_JOB_SOURCE_REF_INVALID",
                    message=f"sample ingest job source_ref '{source_ref}' is invalid",
                    details={"source_ref": source_ref},
                ) from exc
        elif key == "profile":
            parse_profile = value
        elif key == "interval":
            try:
                position_interval_seconds = int(value)
            except ValueError as exc:
                raise AppError(
                    code="INGEST_JOB_SOURCE_REF_INVALID",
                    message=f"sample ingest job source_ref '{source_ref}' is invalid",
                    details={"source_ref": source_ref},
                ) from exc
        else:
            raise AppError(
                code="INGEST_JOB_SOURCE_REF_INVALID",
                message=f"sample ingest job source_ref '{source_ref}' is invalid",
                details={"source_ref": source_ref},
            )
    _validate_parse_options(parse_profile, position_interval_seconds)
    return parts[1], parts[2], max_matches, parse_profile, position_interval_seconds


def _validate_parse_options(parse_profile: str, position_interval_seconds: int) -> None:
    if parse_profile not in PARSE_PROFILES:
        raise AppError(
            code="INGEST_PARSE_PROFILE_INVALID",
            message=f"parse_profile must be one of {sorted(PARSE_PROFILES)}",
            details={"parse_profile": parse_profile},
        )
    if position_interval_seconds <= 0:
        raise AppError(
            code="INGEST_POSITION_INTERVAL_INVALID",
            message="position_interval_seconds must be greater than zero",
            details={"position_interval_seconds": position_interval_seconds},
        )


def _empty_stats(*, total_count: int) -> dict[str, int]:
    return {
        "total_count": total_count,
        "success_count": 0,
        "skipped_count": 0,
        "failed_count": 0,
    }


def _log_parse_warnings(match_id: str, warnings: list[str]) -> None:
    for warning in warnings:
        logger.warning("match '%s' parse warning: %s", match_id, warning)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
