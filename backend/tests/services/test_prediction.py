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


def _distance(start: Point, end: Point) -> float:
    return ((start.x - end.x) ** 2 + (start.y - end.y) ** 2) ** 0.5


def _seed_model(
    connection: sqlite3.Connection,
    tmp_path: Path,
    groups: list[dict[str, object]],
    *,
    feature_groups: list[dict[str, object]] | None = None,
    run_id: str = "model-test",
    created_at: str = "2026-06-05T00:00:00+00:00",
    validation_error: float | None = None,
) -> str:
    algorithm = (
        "weighted_feature_offset_v1"
        if feature_groups is not None
        else "statistical_mean_offset_v1"
    )
    artifact_path = tmp_path / f"{run_id}.json"
    payload: dict[str, object] = {"groups": groups}
    if feature_groups is not None:
        payload.update(
            {
                "schema_version": 1,
                "algorithm": "weighted_feature_offset_v1",
                "feature_model": {
                    "grid_size": 2,
                    "groups": feature_groups,
                },
            }
        )
    artifact_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    repo = SQLiteRepository(connection)
    repo.insert_or_ignore(
        "model_runs",
        {
            "id": run_id,
            "created_at": created_at,
            "maps_included": json.dumps(["erangel"]),
            "phases_included": json.dumps([1]),
            "sample_count": 5,
            "algorithm": algorithm,
            "model_path": str(artifact_path),
            "status": "completed",
        },
    )
    if validation_error is not None:
        for target_type in ("next", "final"):
            repo.insert_or_ignore(
                "model_metrics",
                {
                    "model_run_id": run_id,
                    "split": "validation",
                    "map_id": "erangel",
                    "current_phase": 1,
                    "target_type": target_type,
                    "sample_count": 2,
                    "mean_center_error": validation_error,
                    "median_center_error": validation_error,
                    "p90_center_error": validation_error,
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


def test_predict_falls_back_when_model_artifact_schema_is_invalid(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    artifact_path = tmp_path / "invalid-model.json"
    artifact_path.write_text(
        json.dumps({"algorithm": "unknown", "groups": []}),
        encoding="utf-8",
    )
    repo = SQLiteRepository(migrated_connection)
    repo.insert_or_ignore(
        "model_runs",
        {
            "id": "model-invalid",
            "created_at": "2026-06-05T00:00:00+00:00",
            "maps_included": json.dumps(["erangel"]),
            "phases_included": json.dumps([1]),
            "sample_count": 5,
            "algorithm": "unknown",
            "model_path": str(artifact_path),
            "status": "completed",
        },
    )
    migrated_connection.commit()
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id is None
    assert result.next_circle.source == "rule_baseline"
    assert "model_artifact_invalid" in result.warnings
    assert "rule_baseline_used" in result.warnings


def test_predict_clamps_model_circle_inside_current_circle(
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
                "offset_x": 800000,
                "offset_y": 0,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 800000,
                "offset_y": 0,
                "sample_count": 5,
            },
        ],
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id == run_id
    assert result.next_circle.source == "model_artifact"
    assert _distance(result.next_circle.center, Point(x=100000, y=100000)) <= 170000
    assert _distance(result.final_circle.center, Point(x=100000, y=100000)) <= 392300


def test_predict_prefers_feature_model_group_over_baseline_group(
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
                "offset_y": 0,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 3000,
                "offset_y": 0,
                "sample_count": 5,
            },
        ],
        feature_groups=[
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "cell_x": 0,
                "cell_y": 0,
                "offset_x": 5000,
                "offset_y": 0,
                "sample_count": 4,
            }
        ],
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id == run_id
    assert result.next_circle.source == "feature_model"
    assert result.next_circle.center.x == pytest.approx(105000)
    assert result.next_circle.center.y == pytest.approx(100000)
    assert result.final_circle.source == "model_artifact"


def test_predict_rule_explanation_treats_feature_model_as_model_source(
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
                "offset_y": 0,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 3000,
                "offset_y": 0,
                "sample_count": 5,
            },
        ],
        feature_groups=[
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "cell_x": 0,
                "cell_y": 0,
                "offset_x": 5000,
                "offset_y": 0,
                "sample_count": 4,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "cell_x": 0,
                "cell_y": 0,
                "offset_x": 7000,
                "offset_y": 0,
                "sample_count": 4,
            },
        ],
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.next_circle.source == "feature_model"
    assert result.final_circle.source == "feature_model"
    assert "使用训练模型 artifact" in result.explanation.text


def test_predict_selects_completed_model_with_best_validation_error(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    better_run_id = _seed_model(
        migrated_connection,
        tmp_path,
        [
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "offset_x": 1000,
                "offset_y": 0,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 3000,
                "offset_y": 0,
                "sample_count": 5,
            },
        ],
        run_id="model-better",
        created_at="2026-06-05T00:00:00+00:00",
        validation_error=100,
    )
    _seed_model(
        migrated_connection,
        tmp_path,
        [
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "offset_x": 9000,
                "offset_y": 0,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 12000,
                "offset_y": 0,
                "sample_count": 5,
            },
        ],
        run_id="model-newer-worse",
        created_at="2026-06-06T00:00:00+00:00",
        validation_error=1000,
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id == better_run_id
    assert result.next_circle.center.x == pytest.approx(101000)


def test_predict_skips_invalid_best_model_and_uses_next_valid_candidate(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    invalid_artifact_path = tmp_path / "model-invalid.json"
    invalid_artifact_path.write_text(
        json.dumps({"schema_version": 1, "algorithm": "unknown", "groups": []}),
        encoding="utf-8",
    )
    repo = SQLiteRepository(migrated_connection)
    repo.insert_or_ignore(
        "model_runs",
        {
            "id": "model-invalid-best",
            "created_at": "2026-06-07T00:00:00+00:00",
            "maps_included": json.dumps(["erangel"]),
            "phases_included": json.dumps([1]),
            "sample_count": 5,
            "algorithm": "unknown",
            "model_path": str(invalid_artifact_path),
            "status": "completed",
        },
    )
    for target_type in ("next", "final"):
        repo.insert_or_ignore(
            "model_metrics",
            {
                "model_run_id": "model-invalid-best",
                "split": "validation",
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": target_type,
                "sample_count": 2,
                "mean_center_error": 1,
                "median_center_error": 1,
                "p90_center_error": 1,
            },
        )
    migrated_connection.commit()
    valid_run_id = _seed_model(
        migrated_connection,
        tmp_path,
        [
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "offset_x": 1000,
                "offset_y": 0,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 3000,
                "offset_y": 0,
                "sample_count": 5,
            },
        ],
        run_id="model-valid-next-best",
        created_at="2026-06-06T00:00:00+00:00",
        validation_error=100,
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id == valid_run_id
    assert result.next_circle.source == "model_artifact"


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
