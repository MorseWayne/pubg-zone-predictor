import json
import sqlite3
from pathlib import Path

import pytest
from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.config_service import ConfigService
from app.services.coordinates import Point
from app.services.prediction import (
    LLMExplanationError,
    LLMSettings,
    PredictionInput,
    PredictionService,
)


class FailingExplanationClient:
    def generate(self, prompt: str, settings: LLMSettings) -> str:
        raise LLMExplanationError("boom")


def _service(
    connection: sqlite3.Connection,
    tmp_path: Path,
    *,
    llm_settings: LLMSettings | None = None,
    explanation_client: object | None = None,
) -> PredictionService:
    return PredictionService(
        connection=connection,
        config_service=ConfigService(Path("config")),
        model_dir=tmp_path,
        llm_settings=llm_settings
        or LLMSettings(enabled=False, base_url=None, api_key=None, model=None, timeout_seconds=1),
        explanation_client=explanation_client,  # type: ignore[arg-type]
    )


def _input(strategy: str = "center", *, use_llm: bool = False) -> PredictionInput:
    return PredictionInput(
        map_id="erangel",
        current_phase=1,
        current_circle_center=Point(x=100000, y=100000),
        team_area=Point(x=80000, y=120000),
        route_strategy=strategy,
        use_llm_explanation=use_llm,
    )


def _seed_model(
    connection: sqlite3.Connection,
    tmp_path: Path,
    groups: list[dict[str, object]],
) -> str:
    run_id = "model-test"
    artifact_path = tmp_path / f"{run_id}.json"
    artifact_path.write_text(
        json.dumps({"groups": groups}, ensure_ascii=False),
        encoding="utf-8",
    )
    repo = SQLiteRepository(connection)
    repo.insert_or_ignore(
        "model_runs",
        {
            "id": run_id,
            "created_at": "2026-06-05T00:00:00+00:00",
            "maps_included": json.dumps(["erangel"]),
            "phases_included": json.dumps([1]),
            "sample_count": 5,
            "algorithm": "statistical_mean_offset_v1",
            "model_path": str(artifact_path),
            "status": "completed",
        },
    )
    connection.commit()
    return run_id


def _seed_hotspots(connection: sqlite3.Connection) -> None:
    repo = SQLiteRepository(connection)
    for tile_x, tile_y, score in ((4, 4, 0.9), (8, 8, 0.3)):
        repo.insert_or_ignore(
            "hotspot_tiles",
            {
                "map_id": "erangel",
                "phase": 1,
                "grid_size": 64,
                "tile_x": tile_x,
                "tile_y": tile_y,
                "density_score": score,
                "kill_death_score": 0,
                "hotspot_score": score,
                "sample_count": 3,
                "generated_at": "2026-06-05T00:00:00+00:00",
            },
        )
    connection.commit()


def test_predict_uses_model_artifact_offsets(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    run_id = _seed_model(
        migrated_connection,
        tmp_path,
        [
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "offset_x": 1000,
                "offset_y": 2000,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 3000,
                "offset_y": 4000,
                "sample_count": 5,
            },
        ],
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id == run_id
    assert result.next_circle.source == "model_artifact"
    assert result.next_circle.center == Point(x=101000, y=102000)
    assert result.final_circle.center == Point(x=103000, y=104000)
    assert "rule_baseline_used" not in result.warnings


def test_predict_returns_rule_baseline_when_model_is_missing(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id is None
    assert result.next_circle.source == "rule_baseline"
    assert result.final_circle.source == "rule_baseline"
    assert result.next_circle.center.x > 100000
    assert result.next_circle.center.y > 100000
    assert "model_not_ready" in result.warnings
    assert "rule_baseline_used" in result.warnings
    assert result.hotspot_summary.available is False
    assert "hotspots_not_available" in result.warnings


def test_predict_falls_back_when_model_group_is_missing(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_model(
        migrated_connection,
        tmp_path,
        [
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "offset_x": 1000,
                "offset_y": 2000,
                "sample_count": 5,
            }
        ],
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.next_circle.source == "model_artifact"
    assert result.final_circle.source == "rule_baseline"
    assert "model_group_missing:final" in result.warnings
    assert "rule_baseline_used" in result.warnings


@pytest.mark.parametrize("strategy", ["edge", "center", "slow", "avoid_hotspots"])
def test_predict_returns_stable_route_for_each_strategy(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
    strategy: str,
) -> None:
    _seed_hotspots(migrated_connection)
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input(strategy))

    assert result.route.strategy == strategy
    assert result.route.waypoints[0] == Point(x=80000, y=120000)
    assert result.route.route_score >= 0
    assert result.hotspot_summary.available is True
    if strategy in {"slow", "avoid_hotspots"}:
        assert len(result.route.waypoints) == 3
    else:
        assert len(result.route.waypoints) == 2


def test_predict_rejects_out_of_range_coordinates(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = _service(migrated_connection, tmp_path)

    with pytest.raises(AppError) as exc_info:
        service.predict(
            PredictionInput(
                map_id="erangel",
                current_phase=1,
                current_circle_center=Point(x=-1, y=100000),
                team_area=Point(x=80000, y=120000),
                route_strategy="center",
            )
        )

    assert exc_info.value.code == "COORDINATE_OUT_OF_RANGE"


def test_predict_rejects_invalid_route_strategy(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = _service(migrated_connection, tmp_path)

    with pytest.raises(AppError) as exc_info:
        service.predict(_input("unknown"))

    assert exc_info.value.code == "INVALID_ROUTE_STRATEGY"


def test_llm_failure_falls_back_to_rule_explanation(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = _service(
        migrated_connection,
        tmp_path,
        llm_settings=LLMSettings(
            enabled=True,
            base_url="http://llm.test/v1",
            api_key="test-key",
            model="test-model",
            timeout_seconds=1,
        ),
        explanation_client=FailingExplanationClient(),
    )

    result = service.predict(_input(use_llm=True))

    assert result.explanation.source == "rule_fallback"
    assert "llm_explanation_failed" in result.warnings
