from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from math import ceil, sqrt
from pathlib import Path
from statistics import median
from typing import Any
from uuid import uuid4

from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.config_service import ConfigService

ARTIFACT_SCHEMA_VERSION = 1
ALGORITHM = "weighted_feature_offset_v1"
FEATURE_GRID_SIZE = 2
MIN_TRAINING_SAMPLES = 5
MIN_GROUP_SAMPLES = 3


@dataclass(frozen=True)
class TrainingSample:
    match_id: str
    map_id: str
    current_phase: int
    current_center_x: float
    current_center_y: float
    next_center_x: float
    next_center_y: float
    final_center_x: float
    final_center_y: float


@dataclass(frozen=True)
class ModelMetric:
    split: str
    map_id: str
    current_phase: int
    target_type: str
    sample_count: int
    mean_center_error: float
    median_center_error: float
    p90_center_error: float | None


@dataclass(frozen=True)
class ModelRun:
    id: str
    created_at: str
    maps_included: list[str]
    phases_included: list[int]
    sample_count: int
    algorithm: str
    model_path: str | None
    status: str
    metrics: list[ModelMetric] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TargetPoint:
    x: float
    y: float


@dataclass(frozen=True)
class BaselineGroup:
    map_id: str
    current_phase: int
    target_type: str
    offset_x: float
    offset_y: float
    sample_count: int


@dataclass(frozen=True)
class FeatureGroup:
    map_id: str
    current_phase: int
    target_type: str
    cell_x: int
    cell_y: int
    offset_x: float
    offset_y: float
    sample_count: int


@dataclass
class TrainingService:
    connection: sqlite3.Connection
    config_service: ConfigService
    model_dir: Path

    def __post_init__(self) -> None:
        self.repo = SQLiteRepository(self.connection)

    def build_samples(self, map_id: str | None = None) -> list[TrainingSample]:
        return self._collect_samples(self._selected_maps(map_id))[0]

    def train_baseline(self, map_id: str | None = None) -> ModelRun:
        selected_maps = self._selected_maps(map_id)
        samples, phases_included = self._collect_samples(selected_maps)
        run_id = f"model_{uuid4().hex}"
        created_at = _utc_now()
        maps_included = [map_config["map_id"] for map_config in selected_maps]
        warnings = self._sample_warnings(samples)

        self._insert_model_run(
            run_id=run_id,
            created_at=created_at,
            maps_included=maps_included,
            phases_included=phases_included,
            sample_count=len(samples),
            model_path=None,
            status="running",
        )

        if not samples:
            self._update_run_status(run_id, status="failed", model_path=None)
            self.connection.commit()
            return ModelRun(
                id=run_id,
                created_at=created_at,
                maps_included=maps_included,
                phases_included=phases_included,
                sample_count=0,
                algorithm=ALGORITHM,
                model_path=None,
                status="failed",
                warnings=warnings,
            )

        train_samples, validation_samples = self._split_samples_by_match(samples)
        groups = self._fit_groups(train_samples)
        feature_groups = self._fit_feature_groups(train_samples, selected_maps)
        metrics = self._evaluate(groups, train_samples, split="train")
        if validation_samples:
            metrics.extend(self._evaluate(groups, validation_samples, split="validation"))
        else:
            warnings.append("validation split unavailable: fewer than 5 matches")
        artifact_path = self._write_artifact(
            run_id=run_id,
            created_at=created_at,
            maps_included=maps_included,
            phases_included=phases_included,
            samples=samples,
            groups=groups,
            feature_groups=feature_groups,
            warnings=warnings,
        )

        for metric in metrics:
            self.repo.insert_or_ignore(
                "model_metrics",
                {
                    "model_run_id": run_id,
                    "split": metric.split,
                    "map_id": metric.map_id,
                    "current_phase": metric.current_phase,
                    "target_type": metric.target_type,
                    "sample_count": metric.sample_count,
                    "mean_center_error": metric.mean_center_error,
                    "median_center_error": metric.median_center_error,
                    "p90_center_error": metric.p90_center_error,
                },
            )
        self._update_run_status(run_id, status="completed", model_path=str(artifact_path))
        self.connection.commit()

        return ModelRun(
            id=run_id,
            created_at=created_at,
            maps_included=maps_included,
            phases_included=phases_included,
            sample_count=len(samples),
            algorithm=ALGORITHM,
            model_path=str(artifact_path),
            status="completed",
            metrics=metrics,
            warnings=warnings,
        )

    def list_runs(self, limit: int = 20) -> list[ModelRun]:
        rows = self.repo.fetch_all(
            """
            SELECT *
            FROM model_runs
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [self._run_from_row(row, metrics=[]) for row in rows]

    def get_run(self, run_id: str) -> ModelRun:
        row = self.repo.fetch_one("SELECT * FROM model_runs WHERE id = ?", (run_id,))
        if row is None:
            raise AppError(
                code="MODEL_RUN_NOT_FOUND",
                message=f"model run '{run_id}' was not found",
                status_code=404,
                details={"run_id": run_id},
            )
        return self._run_from_row(row, metrics=self.get_metrics(run_id))

    def get_metrics(self, run_id: str) -> list[ModelMetric]:
        rows = self.repo.fetch_all(
            """
            SELECT split, map_id, current_phase, target_type, sample_count,
                   mean_center_error, median_center_error, p90_center_error
            FROM model_metrics
            WHERE model_run_id = ?
            ORDER BY split ASC, map_id ASC, current_phase ASC, target_type ASC
            """,
            (run_id,),
        )
        return [self._metric_from_row(row) for row in rows]

    def _collect_samples(
        self,
        selected_maps: list[dict[str, Any]],
    ) -> tuple[list[TrainingSample], list[int]]:
        samples: list[TrainingSample] = []
        phases_included: set[int] = set()
        for map_config in selected_maps:
            zone_config = self.config_service.get_zone_phases(map_config["map_id"])
            final_phase = int(zone_config["final_phase"])
            supported_phases = [int(phase) for phase in zone_config["supported_prediction_phases"]]
            phases_included.update(supported_phases)
            samples.extend(
                self._samples_for_map(
                    map_config=map_config,
                    supported_phases=supported_phases,
                    final_phase=final_phase,
                )
            )
        return samples, sorted(phases_included)

    def _samples_for_map(
        self,
        map_config: dict[str, Any],
        supported_phases: list[int],
        final_phase: int,
    ) -> list[TrainingSample]:
        telemetry_names = [str(name) for name in map_config.get("telemetry_names", [])]
        if not telemetry_names or not supported_phases:
            return []

        telemetry_placeholders = ", ".join("?" for _ in telemetry_names)
        phase_placeholders = ", ".join("?" for _ in supported_phases)
        rows = self.repo.fetch_all(
            f"""
            SELECT m.match_id,
                   c.phase AS current_phase,
                   c.center_x AS current_center_x,
                   c.center_y AS current_center_y,
                   n.center_x AS next_center_x,
                   n.center_y AS next_center_y,
                   f.center_x AS final_center_x,
                   f.center_y AS final_center_y
            FROM circle_phases c
            JOIN matches m ON m.match_id = c.match_id
            JOIN circle_phases n
              ON n.match_id = c.match_id
             AND n.phase = c.phase + 1
            JOIN circle_phases f
              ON f.match_id = c.match_id
             AND f.phase = ?
            WHERE m.map_name IN ({telemetry_placeholders})
              AND c.phase IN ({phase_placeholders})
            ORDER BY m.match_id ASC, c.phase ASC
            """,
            (final_phase, *telemetry_names, *supported_phases),
        )
        return [self._sample_from_row(row, map_config["map_id"]) for row in rows]

    @staticmethod
    def _fit_groups(samples: list[TrainingSample]) -> list[BaselineGroup]:
        targets: dict[tuple[str, int, str], list[tuple[float, float]]] = defaultdict(list)
        for sample in samples:
            targets[(sample.map_id, sample.current_phase, "next")].append(
                (
                    sample.next_center_x - sample.current_center_x,
                    sample.next_center_y - sample.current_center_y,
                )
            )
            targets[(sample.map_id, sample.current_phase, "final")].append(
                (
                    sample.final_center_x - sample.current_center_x,
                    sample.final_center_y - sample.current_center_y,
                )
            )

        groups: list[BaselineGroup] = []
        for (map_id, current_phase, target_type), offsets in sorted(targets.items()):
            groups.append(
                BaselineGroup(
                    map_id=map_id,
                    current_phase=current_phase,
                    target_type=target_type,
                    offset_x=float(median(offset[0] for offset in offsets)),
                    offset_y=float(median(offset[1] for offset in offsets)),
                    sample_count=len(offsets),
                )
            )
        return groups

    def _fit_feature_groups(
        self,
        samples: list[TrainingSample],
        selected_maps: list[dict[str, Any]],
    ) -> list[FeatureGroup]:
        map_configs = {str(map_config["map_id"]): map_config for map_config in selected_maps}
        targets: dict[tuple[str, int, str, int, int], list[tuple[float, float]]] = defaultdict(list)
        for sample in samples:
            map_config = map_configs.get(sample.map_id)
            if map_config is None:
                continue
            cell_x, cell_y = self._feature_cell(sample, map_config)
            targets[(sample.map_id, sample.current_phase, "next", cell_x, cell_y)].append(
                (
                    sample.next_center_x - sample.current_center_x,
                    sample.next_center_y - sample.current_center_y,
                )
            )
            targets[(sample.map_id, sample.current_phase, "final", cell_x, cell_y)].append(
                (
                    sample.final_center_x - sample.current_center_x,
                    sample.final_center_y - sample.current_center_y,
                )
            )

        feature_groups: list[FeatureGroup] = []
        for (map_id, current_phase, target_type, cell_x, cell_y), offsets in sorted(
            targets.items()
        ):
            feature_groups.append(
                FeatureGroup(
                    map_id=map_id,
                    current_phase=current_phase,
                    target_type=target_type,
                    cell_x=cell_x,
                    cell_y=cell_y,
                    offset_x=float(median(offset[0] for offset in offsets)),
                    offset_y=float(median(offset[1] for offset in offsets)),
                    sample_count=len(offsets),
                )
            )
        return feature_groups

    def _evaluate(
        self,
        groups: list[BaselineGroup],
        samples: list[TrainingSample],
        *,
        split: str,
    ) -> list[ModelMetric]:
        group_lookup = {
            (group.map_id, group.current_phase, group.target_type): group for group in groups
        }
        errors: dict[tuple[str, int, str], list[float]] = defaultdict(list)
        for sample in samples:
            for target_type, target in self._sample_targets(sample).items():
                group = group_lookup.get((sample.map_id, sample.current_phase, target_type))
                if group is None:
                    continue
                predicted = TargetPoint(
                    x=sample.current_center_x + group.offset_x,
                    y=sample.current_center_y + group.offset_y,
                )
                errors[(sample.map_id, sample.current_phase, target_type)].append(
                    _center_error(predicted, target)
                )

        metrics: list[ModelMetric] = []
        for (map_id, current_phase, target_type), group_errors in sorted(errors.items()):
            sorted_errors = sorted(group_errors)
            metrics.append(
                ModelMetric(
                    split=split,
                    map_id=map_id,
                    current_phase=current_phase,
                    target_type=target_type,
                    sample_count=len(sorted_errors),
                    mean_center_error=_round(sum(sorted_errors) / len(sorted_errors)),
                    median_center_error=_round(float(median(sorted_errors))),
                    p90_center_error=_round(_percentile(sorted_errors, 0.9)),
                )
            )
        return metrics

    def _write_artifact(
        self,
        run_id: str,
        created_at: str,
        maps_included: list[str],
        phases_included: list[int],
        samples: list[TrainingSample],
        groups: list[BaselineGroup],
        feature_groups: list[FeatureGroup],
        warnings: list[str],
    ) -> Path:
        payload = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "id": run_id,
            "created_at": created_at,
            "algorithm": ALGORITHM,
            "training_data": {
                "maps_included": maps_included,
                "phases_included": phases_included,
                "sample_count": len(samples),
            },
            "maps_included": maps_included,
            "phases_included": phases_included,
            "sample_count": len(samples),
            "warnings": warnings,
            "feature_model": {
                "grid_size": FEATURE_GRID_SIZE,
                "groups": [
                    {
                        "map_id": group.map_id,
                        "current_phase": group.current_phase,
                        "target_type": group.target_type,
                        "cell_x": group.cell_x,
                        "cell_y": group.cell_y,
                        "offset_x": _round(group.offset_x),
                        "offset_y": _round(group.offset_y),
                        "sample_count": group.sample_count,
                    }
                    for group in feature_groups
                ],
            },
            "groups": [
                {
                    "map_id": group.map_id,
                    "current_phase": group.current_phase,
                    "target_type": group.target_type,
                    "offset_x": _round(group.offset_x),
                    "offset_y": _round(group.offset_y),
                    "sample_count": group.sample_count,
                }
                for group in groups
            ],
        }
        self.model_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = self.model_dir / f"{run_id}.json"
        artifact_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return artifact_path

    def _insert_model_run(
        self,
        *,
        run_id: str,
        created_at: str,
        maps_included: list[str],
        phases_included: list[int],
        sample_count: int,
        model_path: str | None,
        status: str,
    ) -> None:
        self.repo.insert_or_ignore(
            "model_runs",
            {
                "id": run_id,
                "created_at": created_at,
                "maps_included": json.dumps(maps_included, ensure_ascii=False),
                "phases_included": json.dumps(phases_included, ensure_ascii=False),
                "sample_count": sample_count,
                "algorithm": ALGORITHM,
                "model_path": model_path,
                "status": status,
            },
        )

    def _update_run_status(self, run_id: str, *, status: str, model_path: str | None) -> None:
        self.repo.execute(
            """
            UPDATE model_runs
            SET status = ?, model_path = ?
            WHERE id = ?
            """,
            (status, model_path, run_id),
        )

    def _sample_warnings(self, samples: list[TrainingSample]) -> list[str]:
        warnings: list[str] = []
        if not samples:
            return ["no circle phase training samples found"]
        if len(samples) < MIN_TRAINING_SAMPLES:
            warnings.append(f"low training sample count: {len(samples)} < {MIN_TRAINING_SAMPLES}")
        low_group_count = sum(
            1 for group in self._fit_groups(samples) if group.sample_count < MIN_GROUP_SAMPLES
        )
        if low_group_count:
            warnings.append(
                f"low sample metric groups: {low_group_count} groups have fewer than "
                f"{MIN_GROUP_SAMPLES} samples"
            )
        return warnings

    @staticmethod
    def _split_samples_by_match(
        samples: list[TrainingSample],
        validation_ratio: float = 0.2,
    ) -> tuple[list[TrainingSample], list[TrainingSample]]:
        match_ids = sorted({sample.match_id for sample in samples})
        if len(match_ids) < 5:
            return samples, []
        validation_count = max(1, round(len(match_ids) * validation_ratio))
        validation_ids = set(match_ids[-validation_count:])
        train_samples = [sample for sample in samples if sample.match_id not in validation_ids]
        validation_samples = [sample for sample in samples if sample.match_id in validation_ids]
        return train_samples, validation_samples

    def _selected_maps(self, map_id: str | None) -> list[dict[str, Any]]:
        if map_id is not None:
            return [self.config_service.get_map(map_id)]
        return self.config_service.list_maps()

    @staticmethod
    def _feature_cell(sample: TrainingSample, map_config: dict[str, Any]) -> tuple[int, int]:
        coordinate = map_config.get("coordinate", {})
        min_x = float(coordinate.get("min_x", 0))
        min_y = float(coordinate.get("min_y", 0))
        max_x = float(coordinate.get("max_x", map_config.get("world_size", 1)))
        max_y = float(coordinate.get("max_y", map_config.get("world_size", 1)))
        normalized_x = (sample.current_center_x - min_x) / max(max_x - min_x, 1)
        normalized_y = (sample.current_center_y - min_y) / max(max_y - min_y, 1)
        cell_x = min(FEATURE_GRID_SIZE - 1, max(0, int(normalized_x * FEATURE_GRID_SIZE)))
        cell_y = min(FEATURE_GRID_SIZE - 1, max(0, int(normalized_y * FEATURE_GRID_SIZE)))
        return cell_x, cell_y

    @staticmethod
    def _sample_targets(sample: TrainingSample) -> dict[str, TargetPoint]:
        return {
            "next": TargetPoint(x=sample.next_center_x, y=sample.next_center_y),
            "final": TargetPoint(x=sample.final_center_x, y=sample.final_center_y),
        }

    @staticmethod
    def _sample_from_row(row: sqlite3.Row, map_id: str) -> TrainingSample:
        return TrainingSample(
            match_id=row["match_id"],
            map_id=map_id,
            current_phase=row["current_phase"],
            current_center_x=row["current_center_x"],
            current_center_y=row["current_center_y"],
            next_center_x=row["next_center_x"],
            next_center_y=row["next_center_y"],
            final_center_x=row["final_center_x"],
            final_center_y=row["final_center_y"],
        )

    @staticmethod
    def _metric_from_row(row: sqlite3.Row) -> ModelMetric:
        return ModelMetric(
            split=row["split"],
            map_id=row["map_id"],
            current_phase=row["current_phase"],
            target_type=row["target_type"],
            sample_count=row["sample_count"],
            mean_center_error=row["mean_center_error"],
            median_center_error=row["median_center_error"],
            p90_center_error=row["p90_center_error"],
        )

    @staticmethod
    def _run_from_row(row: sqlite3.Row, metrics: list[ModelMetric]) -> ModelRun:
        return ModelRun(
            id=row["id"],
            created_at=row["created_at"],
            maps_included=_loads_list(row["maps_included"]),
            phases_included=[int(phase) for phase in _loads_list(row["phases_included"])],
            sample_count=row["sample_count"],
            algorithm=row["algorithm"],
            model_path=row["model_path"],
            status=row["status"],
            metrics=metrics,
        )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _center_error(predicted: TargetPoint, actual: TargetPoint) -> float:
    return sqrt((predicted.x - actual.x) ** 2 + (predicted.y - actual.y) ** 2)


def _percentile(sorted_values: list[float], percentile: float) -> float:
    if not sorted_values:
        return 0
    index = max(0, ceil(percentile * len(sorted_values)) - 1)
    return sorted_values[min(index, len(sorted_values) - 1)]


def _round(value: float) -> float:
    return round(value, 6)


def _loads_list(value: str) -> list[Any]:
    parsed = json.loads(value)
    return parsed if isinstance(parsed, list) else []
