from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.db.connection import connect_database
from app.services.ingest import IngestJobResult, IngestService
from app.services.pubg_api import PubgApiClient

router = APIRouter(prefix="/api/ingest", tags=["ingest"])
SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_database_connection(settings: SettingsDep) -> Iterator[sqlite3.Connection]:
    connection = connect_database(settings.database_path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


DatabaseDep = Annotated[sqlite3.Connection, Depends(get_database_connection)]


def get_pubg_client(settings: SettingsDep) -> PubgApiClient:
    return PubgApiClient(
        api_key=settings.pubg_api_key,
        base_url=settings.pubg_api_base_url,
        timeout_seconds=settings.pubg_api_timeout_seconds,
    )


PubgClientDep = Annotated[PubgApiClient, Depends(get_pubg_client)]


def get_ingest_service(
    connection: DatabaseDep,
    pubg_client: PubgClientDep,
    settings: SettingsDep,
) -> IngestService:
    return IngestService(
        connection=connection,
        pubg_client=pubg_client,
        telemetry_cache_dir=settings.telemetry_cache_dir,
    )


IngestServiceDep = Annotated[IngestService, Depends(get_ingest_service)]


@router.post("/tournaments")
def ingest_tournaments(ingest_service: IngestServiceDep) -> dict[str, object]:
    return _job_response(ingest_service.ingest_tournaments())


@router.post("/tournaments/{tournament_id}")
def ingest_tournament(
    tournament_id: str,
    ingest_service: IngestServiceDep,
) -> dict[str, object]:
    return _job_response(ingest_service.ingest_tournament(tournament_id))


@router.post("/matches/{match_id}/telemetry")
def download_match_telemetry(
    match_id: str,
    ingest_service: IngestServiceDep,
) -> dict[str, object]:
    return _job_response(ingest_service.download_match_telemetry(match_id))


@router.get("/jobs/{job_id}")
def get_job(job_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _job_response(ingest_service.get_job(job_id))


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _job_response(ingest_service.retry_job(job_id))


def _job_response(job: IngestJobResult) -> dict[str, object]:
    return {
        "id": job.id,
        "job_type": job.job_type,
        "status": job.status,
        "source_ref": job.source_ref,
        "total_count": job.total_count,
        "success_count": job.success_count,
        "skipped_count": job.skipped_count,
        "failed_count": job.failed_count,
        "retry_count": job.retry_count,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "warnings": job.warnings,
    }
