from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.config import get_config_service
from app.core.config import Settings, get_settings
from app.db.connection import connect_database
from app.services.config_service import ConfigService
from app.services.coordinates import Point
from app.services.prediction import (
    ExplanationResult,
    LLMSettings,
    PredictedCircle,
    PredictionHotspotSummary,
    PredictionInput,
    PredictionResult,
    PredictionService,
    RouteResult,
)

router = APIRouter(prefix="/api/predict", tags=["predict"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
ConfigServiceDep = Annotated[ConfigService, Depends(get_config_service)]


class PointRequest(BaseModel):
    x: float
    y: float


class PredictRequest(BaseModel):
    map_id: str
    current_phase: int = Field(ge=1, le=7)
    current_circle_center: PointRequest
    team_area: PointRequest
    route_strategy: str
    use_llm_explanation: bool = False


class PredictResponse(BaseModel):
    map_id: str
    current_phase: int
    next_circle: dict[str, object]
    final_circle: dict[str, object]
    route: dict[str, object]
    hotspot_summary: dict[str, object]
    explanation: dict[str, object]
    model_run_id: str | None
    warnings: list[str]


def get_prediction_database_connection(settings: SettingsDep) -> Iterator[sqlite3.Connection]:
    connection = connect_database(settings.database_path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


PredictionDatabaseDep = Annotated[sqlite3.Connection, Depends(get_prediction_database_connection)]


def get_prediction_service(
    connection: PredictionDatabaseDep,
    config_service: ConfigServiceDep,
    settings: SettingsDep,
) -> PredictionService:
    return PredictionService(
        connection=connection,
        config_service=config_service,
        model_dir=settings.model_dir,
        llm_settings=LLMSettings(
            enabled=settings.llm_enabled,
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            timeout_seconds=settings.llm_timeout_seconds,
        ),
    )


PredictionServiceDep = Annotated[PredictionService, Depends(get_prediction_service)]


@router.post("", response_model=PredictResponse)
def predict_zone(
    request: PredictRequest,
    prediction_service: PredictionServiceDep,
) -> dict[str, object]:
    result = prediction_service.predict(
        PredictionInput(
            map_id=request.map_id,
            current_phase=request.current_phase,
            current_circle_center=_point(request.current_circle_center),
            team_area=_point(request.team_area),
            route_strategy=request.route_strategy,
            use_llm_explanation=request.use_llm_explanation,
        )
    )
    return _prediction_response(result)


def _point(point: PointRequest) -> Point:
    return Point(x=point.x, y=point.y)


def _prediction_response(result: PredictionResult) -> dict[str, object]:
    return {
        "map_id": result.map_id,
        "current_phase": result.current_phase,
        "next_circle": _circle_response(result.next_circle),
        "final_circle": _circle_response(result.final_circle),
        "route": _route_response(result.route),
        "hotspot_summary": _hotspot_summary_response(result.hotspot_summary),
        "explanation": _explanation_response(result.explanation),
        "model_run_id": result.model_run_id,
        "warnings": result.warnings,
    }


def _circle_response(circle: PredictedCircle) -> dict[str, object]:
    return {
        "phase": circle.phase,
        "center": _point_response(circle.center),
        "radius": circle.radius,
        "source": circle.source,
        "sample_count": circle.sample_count,
    }


def _route_response(route: RouteResult) -> dict[str, object]:
    return {
        "strategy": route.strategy,
        "target": _point_response(route.target),
        "waypoints": [_point_response(point) for point in route.waypoints],
        "route_score": route.route_score,
        "risk_summary": {
            "hotspot_risk": route.risk_summary.hotspot_risk,
            "hotspot_score": route.risk_summary.hotspot_score,
            "distance": route.risk_summary.distance,
        },
    }


def _hotspot_summary_response(summary: PredictionHotspotSummary) -> dict[str, object]:
    return {
        "phase": summary.phase,
        "available": summary.available,
        "generated_at": summary.generated_at,
        "grid_size": summary.grid_size,
        "top_tiles": [
            {
                "tile_x": tile.tile_x,
                "tile_y": tile.tile_y,
                "hotspot_score": tile.hotspot_score,
                "density_score": tile.density_score,
                "kill_death_score": tile.kill_death_score,
                "sample_count": tile.sample_count,
            }
            for tile in summary.top_tiles
        ],
        "max_hotspot_score": summary.max_hotspot_score,
        "warnings": summary.warnings,
    }


def _explanation_response(explanation: ExplanationResult) -> dict[str, object]:
    return {"source": explanation.source, "text": explanation.text}


def _point_response(point: Point) -> dict[str, float]:
    return {"x": round(point.x, 6), "y": round(point.y, 6)}
