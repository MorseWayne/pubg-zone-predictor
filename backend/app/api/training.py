from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.config import get_config_service
from app.core.config import Settings, get_settings
from app.db.connection import connect_database
from app.services.config_service import ConfigService
from app.services.training import ModelMetric, ModelRun, TrainingService

router = APIRouter(prefix="/api/training", tags=["training"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
ConfigServiceDep = Annotated[ConfigService, Depends(get_config_service)]


def get_training_database_connection(settings: SettingsDep) -> Iterator[sqlite3.Connection]:
    connection = connect_database(settings.database_path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


TrainingDatabaseDep = Annotated[sqlite3.Connection, Depends(get_training_database_connection)]


def get_training_service(
    connection: TrainingDatabaseDep,
    config_service: ConfigServiceDep,
    settings: SettingsDep,
) -> TrainingService:
    return TrainingService(
        connection=connection,
        config_service=config_service,
        model_dir=settings.model_dir,
    )


TrainingServiceDep = Annotated[TrainingService, Depends(get_training_service)]


@router.post("/runs")
def train_model_run(
    training_service: TrainingServiceDep,
    map_id: str | None = None,
) -> dict[str, object]:
    return _model_run_response(training_service.train_baseline(map_id=map_id))


@router.get("/runs")
def list_model_runs(
    training_service: TrainingServiceDep,
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, object]:
    return {"runs": [_model_run_response(run) for run in training_service.list_runs(limit=limit)]}


@router.get("/runs/{run_id}")
def get_model_run(run_id: str, training_service: TrainingServiceDep) -> dict[str, object]:
    return _model_run_response(training_service.get_run(run_id))


@router.get("/runs/{run_id}/metrics")
def get_model_metrics(run_id: str, training_service: TrainingServiceDep) -> dict[str, object]:
    metrics = [_metric_response(metric) for metric in training_service.get_metrics(run_id)]
    return {"run_id": run_id, "metrics": metrics}


def _model_run_response(run: ModelRun) -> dict[str, object]:
    return {
        "id": run.id,
        "created_at": run.created_at,
        "maps_included": run.maps_included,
        "phases_included": run.phases_included,
        "sample_count": run.sample_count,
        "algorithm": run.algorithm,
        "model_path": run.model_path,
        "status": run.status,
        "metrics": [_metric_response(metric) for metric in run.metrics],
        "warnings": run.warnings,
    }


def _metric_response(metric: ModelMetric) -> dict[str, object]:
    return {
        "map_id": metric.map_id,
        "current_phase": metric.current_phase,
        "target_type": metric.target_type,
        "sample_count": metric.sample_count,
        "mean_center_error": metric.mean_center_error,
        "median_center_error": metric.median_center_error,
        "p90_center_error": metric.p90_center_error,
    }
