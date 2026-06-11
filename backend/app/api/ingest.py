from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Query

from app.core.config import Settings, get_settings
from app.db.connection import connect_database
from app.services.ingest import (
    DEFAULT_SAMPLE_PARSE_PROFILE,
    DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
    DeleteMatchResult,
    IngestJobResult,
    IngestMatchAsset,
    IngestService,
)
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


SampleIngestRunner = Callable[[str, str, str, int | None, str, int], None]


def get_sample_ingest_runner(settings: SettingsDep) -> SampleIngestRunner:
    def run(
        job_id: str,
        platform: str,
        game_mode: str,
        max_matches: int | None,
        parse_profile: str,
        position_interval_seconds: int,
    ) -> None:
        connection = connect_database(settings.database_path)
        try:
            pubg_client = PubgApiClient(
                api_key=settings.pubg_api_key,
                base_url=settings.pubg_api_base_url,
                timeout_seconds=settings.pubg_api_timeout_seconds,
            )
            service = IngestService(
                connection=connection,
                pubg_client=pubg_client,
                telemetry_cache_dir=settings.telemetry_cache_dir,
            )
            service.run_sample_matches_job(
                job_id,
                platform=platform,
                game_mode=game_mode,
                max_matches=max_matches,
                parse_profile=parse_profile,
                position_interval_seconds=position_interval_seconds,
            )
        finally:
            connection.close()

    return run


SampleIngestRunnerDep = Annotated[SampleIngestRunner, Depends(get_sample_ingest_runner)]


@router.post("/tournaments")
def ingest_tournaments(ingest_service: IngestServiceDep) -> dict[str, object]:
    return _job_response(ingest_service.ingest_tournaments())


@router.post("/tournaments/{tournament_id}")
def ingest_tournament(
    tournament_id: str,
    ingest_service: IngestServiceDep,
) -> dict[str, object]:
    return _job_response(ingest_service.ingest_tournament(tournament_id))


@router.post("/samples/squad")
def ingest_squad_samples(
    background_tasks: BackgroundTasks,
    ingest_service: IngestServiceDep,
    sample_ingest_runner: SampleIngestRunnerDep,
    platform: str = Query(default="steam", pattern=r"^[a-z0-9-]+$"),
    max_matches: int = Query(default=20, ge=1, le=100),
    parse_profile: str = Query(
        default=DEFAULT_SAMPLE_PARSE_PROFILE,
        pattern=r"^(full|hotspot_light|zone_only)$",
    ),
    position_interval_seconds: int = Query(
        default=DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        ge=5,
        le=120,
    ),
) -> dict[str, object]:
    job = ingest_service.start_sample_matches(
        platform=platform,
        game_mode="squad",
        max_matches=max_matches,
        parse_profile=parse_profile,
        position_interval_seconds=position_interval_seconds,
    )
    background_tasks.add_task(
        sample_ingest_runner,
        job.id,
        platform,
        "squad",
        max_matches,
        parse_profile,
        position_interval_seconds,
    )
    return _job_response(job)


@router.post("/matches/{match_id}/telemetry")
def download_match_telemetry(
    match_id: str,
    ingest_service: IngestServiceDep,
) -> dict[str, object]:
    return _job_response(ingest_service.download_match_telemetry(match_id))


@router.post("/matches/{match_id}/telemetry/parse")
def parse_match_telemetry(
    match_id: str,
    ingest_service: IngestServiceDep,
) -> dict[str, object]:
    return _job_response(ingest_service.parse_match_telemetry(match_id))


@router.get("/matches")
def list_matches(
    ingest_service: IngestServiceDep,
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, object]:
    matches = ingest_service.list_matches(limit=limit)
    return {"matches": [_match_response(match) for match in matches]}


@router.delete("/matches/{match_id}")
def delete_match(match_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _delete_match_response(ingest_service.delete_match(match_id))


@router.get("/jobs/{job_id}")
def get_job(job_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _job_response(ingest_service.get_job(job_id))


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _job_response(ingest_service.retry_job(job_id))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _job_response(ingest_service.cancel_job(job_id))


def _match_response(match: IngestMatchAsset) -> dict[str, object]:
    return {
        "match_id": match.match_id,
        "map_name": match.map_name,
        "shard_id": match.shard_id,
        "game_mode": match.game_mode,
        "match_type": match.match_type,
        "created_at": match.created_at,
        "duration": match.duration,
        "ingest_status": match.ingest_status,
        "telemetry_url": match.telemetry_url,
        "telemetry_cache_path": match.telemetry_cache_path,
        "telemetry_parse_status": match.telemetry_parse_status,
        "telemetry_downloaded_at": match.telemetry_downloaded_at,
        "circle_phase_count": match.circle_phase_count,
        "position_sample_count": match.position_sample_count,
        "life_event_count": match.life_event_count,
    }


def _delete_match_response(result: DeleteMatchResult) -> dict[str, object]:
    return {
        "match_id": result.match_id,
        "deleted": result.deleted,
        "telemetry_cache_deleted": result.telemetry_cache_deleted,
        "circle_phase_count": result.circle_phase_count,
        "position_sample_count": result.position_sample_count,
        "life_event_count": result.life_event_count,
    }


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
