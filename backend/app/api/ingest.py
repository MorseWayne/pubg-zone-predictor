from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.db.connection import connect_database
from app.services.ingest import (
    DEFAULT_SAMPLE_PARSE_PROFILE,
    DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
    DeleteMatchResult,
    IngestJobResult,
    IngestMatchAsset,
    IngestService,
    MatchAnalysis,
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
PlayerIngestRunner = Callable[[str, str, list[str], str, int | None, str, int], None]


class PlayerIngestRequest(BaseModel):
    platform: str = Field(default="steam", pattern=r"^[a-z0-9-]+$")
    player_names: list[str] = Field(min_length=1, max_length=10)
    game_mode: str = Field(default="squad", pattern=r"^[a-z0-9-]+$")
    max_matches_per_player: int = Field(default=20, ge=1, le=100)
    parse_profile: str = Field(
        default=DEFAULT_SAMPLE_PARSE_PROFILE,
        pattern=r"^(full|hotspot_light|zone_only)$",
    )
    position_interval_seconds: int = Field(
        default=DEFAULT_SAMPLE_POSITION_INTERVAL_SECONDS,
        ge=5,
        le=120,
    )


class DeleteMatchesRequest(BaseModel):
    match_ids: list[str] = Field(min_length=1, max_length=200)


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


def get_player_ingest_runner(settings: SettingsDep) -> PlayerIngestRunner:
    def run(
        job_id: str,
        platform: str,
        player_names: list[str],
        game_mode: str,
        max_matches_per_player: int | None,
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
            service.run_player_matches_job(
                job_id,
                platform=platform,
                player_names=player_names,
                game_mode=game_mode,
                max_matches_per_player=max_matches_per_player,
                parse_profile=parse_profile,
                position_interval_seconds=position_interval_seconds,
            )
        finally:
            connection.close()

    return run


PlayerIngestRunnerDep = Annotated[PlayerIngestRunner, Depends(get_player_ingest_runner)]


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


@router.post("/players")
def ingest_player_matches(
    request: PlayerIngestRequest,
    background_tasks: BackgroundTasks,
    ingest_service: IngestServiceDep,
    player_ingest_runner: PlayerIngestRunnerDep,
) -> dict[str, object]:
    job = ingest_service.start_player_matches(
        platform=request.platform,
        player_names=request.player_names,
        game_mode=request.game_mode,
        max_matches_per_player=request.max_matches_per_player,
        parse_profile=request.parse_profile,
        position_interval_seconds=request.position_interval_seconds,
    )
    background_tasks.add_task(
        player_ingest_runner,
        job.id,
        request.platform,
        request.player_names,
        request.game_mode,
        request.max_matches_per_player,
        request.parse_profile,
        request.position_interval_seconds,
    )
    return _job_response(job)


@router.get("/players/search")
def search_players(
    pubg_client: PubgClientDep,
    platform: str = Query(default="steam", pattern=r"^[a-z0-9-]+$"),
    query: str = Query(min_length=1, max_length=64),
) -> dict[str, object]:
    try:
        payload = pubg_client.get_players_by_names(platform, [query])
    except AppError as exc:
        reason = str(exc.details.get("reason", ""))
        if exc.code == "PUBG_API_REQUEST_FAILED" and "404" in reason:
            return {"players": []}
        raise
    players = payload.get("data", [])
    return {
        "players": [
            _player_search_response(player, platform)
            for player in players
            if isinstance(player, dict)
        ]
    }


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


@router.get("/matches/{match_id}/analysis")
def get_match_analysis(match_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _match_analysis_response(ingest_service.get_match_analysis(match_id))


@router.delete("/matches")
def delete_matches(
    request: DeleteMatchesRequest,
    ingest_service: IngestServiceDep,
) -> dict[str, object]:
    results = ingest_service.delete_matches(request.match_ids)
    return {
        "deleted_count": len(results),
        "matches": [_delete_match_response(result) for result in results],
    }


@router.delete("/matches/{match_id}")
def delete_match(match_id: str, ingest_service: IngestServiceDep) -> dict[str, object]:
    return _delete_match_response(ingest_service.delete_match(match_id))


@router.get("/jobs")
def list_jobs(
    ingest_service: IngestServiceDep,
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, object]:
    jobs = ingest_service.list_jobs(limit=limit)
    return {"jobs": [_job_response(job) for job in jobs]}


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
        "telemetry_parse_profile": match.telemetry_parse_profile,
        "telemetry_position_interval_seconds": match.telemetry_position_interval_seconds,
        "telemetry_parsed_at": match.telemetry_parsed_at,
        "circle_phase_count": match.circle_phase_count,
        "position_sample_count": match.position_sample_count,
        "life_event_count": match.life_event_count,
    }


def _match_analysis_response(analysis: MatchAnalysis) -> dict[str, object]:
    return {
        "match": _match_response(analysis.match),
        "players": [
            {
                "player_id": player.player_id,
                "player_name": player.player_name,
                "team_id": player.team_id,
                "team_rank": player.team_rank,
                "is_unknown_team": player.is_unknown_team,
            }
            for player in analysis.players
        ],
        "circles": [
            {
                "phase": circle.phase,
                "elapsed_time": circle.elapsed_time,
                "center": {"x": circle.center_x, "y": circle.center_y},
                "radius": circle.radius,
                "num_alive_teams": circle.num_alive_teams,
                "num_alive_players": circle.num_alive_players,
            }
            for circle in analysis.circles
        ],
        "positions": [
            {
                "player_id": position.player_id,
                "team_id": position.team_id,
                "phase": position.phase,
                "elapsed_time": position.elapsed_time,
                "point": {"x": position.x, "y": position.y},
                "z": position.z,
                "alive": position.alive,
            }
            for position in analysis.positions
        ],
        "life_events": [
            {
                "id": event.id,
                "elapsed_time": event.elapsed_time,
                "phase": event.phase,
                "event_type": event.event_type,
                "actor_player_id": event.actor_player_id,
                "actor_player_name": event.actor_player_name,
                "actor_team_id": event.actor_team_id,
                "victim_player_id": event.victim_player_id,
                "victim_player_name": event.victim_player_name,
                "victim_team_id": event.victim_team_id,
                "point": (
                    {"x": event.x, "y": event.y}
                    if event.x is not None and event.y is not None
                    else None
                ),
            }
            for event in analysis.life_events
        ],
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


def _player_search_response(player: dict[str, object], platform: str) -> dict[str, object]:
    attributes = player.get("attributes", {})
    relationships = player.get("relationships", {})
    matches = relationships.get("matches", {}) if isinstance(relationships, dict) else {}
    match_refs = matches.get("data", []) if isinstance(matches, dict) else []
    player_id = player.get("id")
    player_name = attributes.get("name") if isinstance(attributes, dict) else None
    return {
        "player_id": player_id if isinstance(player_id, str) else "",
        "player_name": player_name if isinstance(player_name, str) else str(player_id or ""),
        "platform": platform,
        "recent_match_count": sum(
            1 for item in match_refs if isinstance(item, dict) and item.get("id")
        ),
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
