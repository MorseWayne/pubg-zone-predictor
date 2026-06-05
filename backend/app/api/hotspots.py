from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.config import get_config_service
from app.core.config import Settings, get_settings
from app.db.connection import connect_database
from app.services.config_service import ConfigService
from app.services.hotspots import DEFAULT_GRID_SIZE, HotspotResult, HotspotService

router = APIRouter(prefix="/api/hotspots", tags=["hotspots"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
ConfigServiceDep = Annotated[ConfigService, Depends(get_config_service)]


def get_hotspot_database_connection(settings: SettingsDep) -> Iterator[sqlite3.Connection]:
    connection = connect_database(settings.database_path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


HotspotDatabaseDep = Annotated[sqlite3.Connection, Depends(get_hotspot_database_connection)]


def get_hotspot_service(
    connection: HotspotDatabaseDep,
    config_service: ConfigServiceDep,
) -> HotspotService:
    return HotspotService(connection=connection, config_service=config_service)


HotspotServiceDep = Annotated[HotspotService, Depends(get_hotspot_service)]


@router.get("")
def get_hotspots(
    hotspot_service: HotspotServiceDep,
    map_id: str,
    phase: int = Query(ge=1, le=8),
    grid_size: int = Query(default=DEFAULT_GRID_SIZE, gt=0),
) -> dict[str, object]:
    return _hotspot_response(hotspot_service.get_latest_hotspots(map_id, phase, grid_size))


@router.post("/generate")
def generate_hotspots(
    hotspot_service: HotspotServiceDep,
    map_id: str,
    phase: int = Query(ge=1, le=8),
    grid_size: int = Query(default=DEFAULT_GRID_SIZE, gt=0),
) -> dict[str, object]:
    return _hotspot_response(hotspot_service.generate_hotspots(map_id, phase, grid_size))


def _hotspot_response(result: HotspotResult) -> dict[str, object]:
    return {
        "map_id": result.map_id,
        "phase": result.phase,
        "grid_size": result.grid_size,
        "generated_at": result.generated_at,
        "summary": {
            "effective_match_count": result.summary.effective_match_count,
            "effective_team_count": result.summary.effective_team_count,
            "tile_count": result.summary.tile_count,
            "max_sample_count": result.summary.max_sample_count,
        },
        "tiles": [
            {
                "tile_x": tile.tile_x,
                "tile_y": tile.tile_y,
                "density_score": tile.density_score,
                "kill_death_score": tile.kill_death_score,
                "hotspot_score": tile.hotspot_score,
                "sample_count": tile.sample_count,
            }
            for tile in result.tiles
        ],
        "warnings": result.warnings,
    }
