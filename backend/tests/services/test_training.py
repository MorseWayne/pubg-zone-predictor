import json
import sqlite3
from pathlib import Path

from app.db.repository import SQLiteRepository
from app.services.config_service import ConfigService
from app.services.training import TrainingService


def _seed_circle_training_samples(connection: sqlite3.Connection, match_count: int = 5) -> None:
    repo = SQLiteRepository(connection)
    repo.insert_or_ignore("tournaments", {"id": "tournament-1", "type": "tournament"})
    for index in range(match_count):
        match_id = f"match-{index + 1}"
        base_x = 1000 + index * 100
        base_y = 2000 + index * 50
        repo.insert_or_ignore(
            "matches",
            {
                "match_id": match_id,
                "tournament_id": "tournament-1",
                "map_name": "Erangel_Main",
            },
        )
        for phase, x, y, radius in (
            (1, base_x, base_y, 400000),
            (2, base_x + 100, base_y + 50, 230000),
            (8, base_x + 400, base_y + 200, 7700),
        ):
            repo.insert_or_ignore(
                "circle_phases",
                {
                    "match_id": match_id,
                    "phase": phase,
                    "elapsed_time": phase * 60,
                    "center_x": x,
                    "center_y": y,
                    "radius": radius,
                },
            )
    connection.commit()


def _seed_feature_training_samples(connection: sqlite3.Connection) -> None:
    repo = SQLiteRepository(connection)
    repo.insert_or_ignore("tournaments", {"id": "tournament-1", "type": "tournament"})
    samples = [
        ("feature-01", 100000, 100000, 1000, 0),
        ("feature-02", 110000, 100000, 1000, 0),
        ("feature-03", 120000, 100000, 1000, 0),
        ("feature-04", 130000, 100000, 1000, 0),
        ("feature-05", 600000, 600000, -2000, 0),
        ("feature-06", 610000, 600000, -2000, 0),
    ]
    for match_id, center_x, center_y, next_offset_x, next_offset_y in samples:
        repo.insert_or_ignore(
            "matches",
            {
                "match_id": match_id,
                "tournament_id": "tournament-1",
                "map_name": "Erangel_Main",
            },
        )
        for phase, x, y, radius in (
            (1, center_x, center_y, 400000),
            (2, center_x + next_offset_x, center_y + next_offset_y, 230000),
            (8, center_x + next_offset_x * 2, center_y + next_offset_y, 7700),
        ):
            repo.insert_or_ignore(
                "circle_phases",
                {
                    "match_id": match_id,
                    "phase": phase,
                    "elapsed_time": phase * 60,
                    "center_x": x,
                    "center_y": y,
                    "radius": radius,
                },
            )
    connection.commit()


def test_build_samples_pairs_current_next_and_final_circles(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_circle_training_samples(migrated_connection)
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    samples = service.build_samples("erangel")

    assert len(samples) == 5
    first_sample = samples[0]
    assert first_sample.map_id == "erangel"
    assert first_sample.current_phase == 1
    assert first_sample.next_center_x == first_sample.current_center_x + 100
    assert first_sample.final_center_y == first_sample.current_center_y + 200


def test_train_baseline_writes_model_run_metrics_and_artifact(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_circle_training_samples(migrated_connection)
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    repo = SQLiteRepository(migrated_connection)
    assert run.status == "completed"
    assert run.sample_count == 5
    assert run.warnings == []
    assert run.model_path is not None
    assert Path(run.model_path).exists()
    payload = json.loads(Path(run.model_path).read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["algorithm"] == "weighted_feature_offset_v1"
    assert payload["training_data"]["sample_count"] == 5
    assert payload["training_data"]["maps_included"] == ["erangel"]
    assert len(run.metrics) == 4
    assert {metric.split for metric in run.metrics} == {"train", "validation"}
    assert {metric.target_type for metric in run.metrics} == {"next", "final"}
    assert all(metric.mean_center_error == 0 for metric in run.metrics)
    stored_run = repo.fetch_one("SELECT status FROM model_runs WHERE id = ?", (run.id,))
    stored_metric_count = repo.fetch_one(
        "SELECT COUNT(*) AS count FROM model_metrics WHERE model_run_id = ?",
        (run.id,),
    )
    assert stored_run["status"] == "completed"
    assert stored_metric_count["count"] == 4


def test_train_baseline_records_failed_run_when_samples_are_missing(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    repo = SQLiteRepository(migrated_connection)
    assert run.status == "failed"
    assert run.sample_count == 0
    assert run.model_path is None
    assert run.metrics == []
    assert run.warnings == ["no circle phase training samples found"]
    stored_run = repo.fetch_one("SELECT status FROM model_runs WHERE id = ?", (run.id,))
    stored_metric_count = repo.fetch_one(
        "SELECT COUNT(*) AS count FROM model_metrics WHERE model_run_id = ?",
        (run.id,),
    )
    assert stored_run["status"] == "failed"
    assert stored_metric_count["count"] == 0


def test_train_baseline_returns_low_sample_warning(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_circle_training_samples(migrated_connection, match_count=2)
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    assert run.status == "completed"
    assert run.sample_count == 2
    assert "low training sample count: 2 < 5" in run.warnings
    assert "low sample metric groups: 2 groups have fewer than 3 samples" in run.warnings
    assert "validation split unavailable: fewer than 5 matches" in run.warnings


def test_train_baseline_records_train_and_validation_metrics(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_circle_training_samples(migrated_connection, match_count=10)
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    metric_splits = {metric.split for metric in run.metrics}
    assert metric_splits == {"train", "validation"}
    assert all(metric.sample_count > 0 for metric in run.metrics)


def test_train_baseline_uses_median_offset_to_reduce_outlier_impact(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_circle_training_samples(migrated_connection, match_count=5)
    repo = SQLiteRepository(migrated_connection)
    repo.execute(
        """
        UPDATE circle_phases
        SET center_x = center_x + 500000
        WHERE match_id = 'match-4' AND phase = 2
        """
    )
    migrated_connection.commit()
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    payload = json.loads(Path(run.model_path).read_text(encoding="utf-8"))
    next_group = next(
        group
        for group in payload["groups"]
        if group["map_id"] == "erangel"
        and group["current_phase"] == 1
        and group["target_type"] == "next"
    )
    assert next_group["offset_x"] == 100


def test_train_baseline_writes_feature_model_groups(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_feature_training_samples(migrated_connection)
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    payload = json.loads(Path(run.model_path).read_text(encoding="utf-8"))
    feature_model = payload["feature_model"]
    feature_groups = {
        (
            group["map_id"],
            group["current_phase"],
            group["target_type"],
            group["cell_x"],
            group["cell_y"],
        ): group
        for group in feature_model["groups"]
    }
    assert payload["algorithm"] == "weighted_feature_offset_v1"
    assert feature_model["grid_size"] == 2
    assert feature_groups[("erangel", 1, "next", 0, 0)]["offset_x"] == 1000
    assert feature_groups[("erangel", 1, "next", 1, 1)]["offset_x"] == -2000
