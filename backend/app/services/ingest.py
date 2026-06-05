from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.pubg_api import PubgApiClient

TERMINAL_JOB_STATUSES = {"completed", "failed", "cancelled"}


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
                    if telemetry_url:
                        self.repo.upsert(
                            "telemetry_assets",
                            {"match_id": match_id, "telemetry_url": telemetry_url},
                            conflict_columns=("match_id",),
                        )
                        stats["success_count"] += 1
                    else:
                        stats["skipped_count"] += 1
                        warnings.append(f"match '{match_id}' has no telemetry URL")
                except AppError as exc:
                    stats["failed_count"] += 1
                    warnings.append(f"match '{match_id}' failed: {exc.message}")

            self._complete_job(job_id, stats, warnings=warnings)
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

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

            content = self.pubg_client.download_telemetry(asset["telemetry_url"])
            content_hash = hashlib.sha256(content).hexdigest()
            cache_path = self.telemetry_cache_dir / f"{match_id}.json"
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(content)
            self.repo.upsert(
                "telemetry_assets",
                {
                    "match_id": match_id,
                    "telemetry_url": asset["telemetry_url"],
                    "cache_path": str(cache_path),
                    "content_hash": content_hash,
                    "downloaded_at": _utc_now(),
                    "parse_status": "pending",
                },
                conflict_columns=("match_id",),
            )
            self._complete_job(
                job_id,
                {"total_count": 1, "success_count": 1, "skipped_count": 0, "failed_count": 0},
            )
        except AppError as exc:
            self._fail_job(job_id, exc.code, exc.message)
        return self.get_job(job_id)

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
        if job.job_type == "telemetry_download" and job.source_ref:
            return self.download_match_telemetry(job.source_ref, retry_count=next_retry_count)
        raise AppError(
            code="INGEST_JOB_NOT_RETRYABLE",
            message=f"ingest job '{job_id}' cannot be retried",
            details={"job_id": job_id, "job_type": job.job_type},
        )

    def _create_job(self, job_type: str, source_ref: str | None, *, retry_count: int = 0) -> str:
        job_id = f"job_{uuid4().hex}"
        self.repo.insert_or_ignore(
            "ingest_jobs",
            {
                "id": job_id,
                "job_type": job_type,
                "status": "running",
                "source_ref": source_ref,
                "retry_count": retry_count,
                "started_at": _utc_now(),
            },
        )
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
            WHERE id = ?
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

    def _fail_job(self, job_id: str, error_code: str, error_message: str) -> None:
        self.repo.execute(
            """
            UPDATE ingest_jobs
            SET status = 'failed',
                failed_count = CASE WHEN total_count = 0 THEN 1 ELSE failed_count END,
                finished_at = ?,
                error_code = ?,
                error_message = ?
            WHERE id = ?
            """,
            (_utc_now(), error_code, error_message, job_id),
        )
        self.connection.commit()

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
    def _match_values(
        match_id: str,
        tournament_id: str,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], str | None]:
        match = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
        attributes = IngestService._attributes(match)
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
        if row["status"] == "completed" and row["error_message"]:
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
            error_message=row["error_message"] if row["status"] != "completed" else None,
            warnings=warnings,
        )


def _empty_stats(*, total_count: int) -> dict[str, int]:
    return {
        "total_count": total_count,
        "success_count": 0,
        "skipped_count": 0,
        "failed_count": 0,
    }


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
