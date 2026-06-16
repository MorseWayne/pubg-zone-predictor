from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from math import sqrt
from pathlib import Path
from typing import Any, Protocol

import httpx

from app.core.errors import AppError
from app.db.repository import SQLiteRepository
from app.services.config_service import ConfigService
from app.services.coordinates import CoordinateTransformer, Point

ROUTE_STRATEGIES = {"edge", "center", "slow", "avoid_hotspots"}
DEFAULT_GRID_SIZE = 64
TOP_HOTSPOT_TILE_COUNT = 5
SUPPORTED_MODEL_SCHEMA_VERSION = 1
SUPPORTED_MODEL_ALGORITHMS = {
    "statistical_mean_offset_v1",
    "statistical_median_offset_v1",
    "weighted_feature_offset_v1",
}


@dataclass(frozen=True)
class PredictionInput:
    map_id: str
    current_phase: int
    current_circle_center: Point
    team_area: Point
    route_strategy: str
    use_llm_explanation: bool = False


@dataclass(frozen=True)
class PredictedCircle:
    phase: int
    center: Point
    radius: float
    source: str
    sample_count: int | None = None


@dataclass(frozen=True)
class HotspotTileSummary:
    tile_x: int
    tile_y: int
    hotspot_score: float
    density_score: float
    kill_death_score: float
    sample_count: int


@dataclass(frozen=True)
class PredictionHotspotSummary:
    phase: int
    available: bool
    generated_at: str | None
    grid_size: int
    top_tiles: list[HotspotTileSummary]
    max_hotspot_score: float
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class RiskSummary:
    hotspot_risk: str
    hotspot_score: float
    distance: float


@dataclass(frozen=True)
class RouteResult:
    strategy: str
    target: Point
    waypoints: list[Point]
    route_score: float
    risk_summary: RiskSummary


@dataclass(frozen=True)
class ExplanationResult:
    source: str
    text: str


@dataclass(frozen=True)
class PredictionResult:
    map_id: str
    current_phase: int
    next_circle: PredictedCircle
    final_circle: PredictedCircle
    route: RouteResult
    hotspot_summary: PredictionHotspotSummary
    explanation: ExplanationResult
    model_run_id: str | None
    warnings: list[str]


@dataclass(frozen=True)
class LLMSettings:
    enabled: bool
    base_url: str | None
    api_key: str | None
    model: str | None
    timeout_seconds: int

    @property
    def is_configured(self) -> bool:
        return bool(self.enabled and self.base_url and self.api_key and self.model)


@dataclass(frozen=True)
class ModelGroup:
    map_id: str
    current_phase: int
    target_type: str
    offset_x: float
    offset_y: float
    sample_count: int


@dataclass(frozen=True)
class FeatureModelGroup:
    map_id: str
    current_phase: int
    target_type: str
    cell_x: int
    cell_y: int
    offset_x: float
    offset_y: float
    sample_count: int


@dataclass(frozen=True)
class LoadedModel:
    run_id: str
    groups: dict[tuple[str, int, str], ModelGroup]
    feature_grid_size: int | None
    feature_groups: dict[tuple[str, int, str, int, int], FeatureModelGroup]


class ExplanationClient(Protocol):
    def generate(self, prompt: str, settings: LLMSettings) -> str: ...


class OpenAICompatibleExplanationClient:
    def generate(self, prompt: str, settings: LLMSettings) -> str:
        if not settings.is_configured:
            raise LLMExplanationError("LLM is not configured")

        response = httpx.post(
            _chat_completions_url(settings.base_url or ""),
            headers={"Authorization": f"Bearer {settings.api_key}"},
            json={
                "model": settings.model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You explain PUBG macro rotation recommendations. "
                            "Do not invent coordinates or override the supplied prediction."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.3,
            },
            timeout=settings.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        content = (
            payload.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )
        if not content:
            raise LLMExplanationError("LLM response was empty")
        return content


class LLMExplanationError(Exception):
    pass


@dataclass
class PredictionService:
    connection: sqlite3.Connection
    config_service: ConfigService
    model_dir: Path
    llm_settings: LLMSettings
    explanation_client: ExplanationClient | None = None

    def __post_init__(self) -> None:
        self.repo = SQLiteRepository(self.connection)
        if self.explanation_client is None:
            self.explanation_client = OpenAICompatibleExplanationClient()

    def predict(self, prediction_input: PredictionInput) -> PredictionResult:
        self._validate_strategy(prediction_input.route_strategy)
        map_config = self.config_service.get_map(prediction_input.map_id)
        map_id = map_config["map_id"]
        transformer = CoordinateTransformer.from_map_config(map_config)
        current_center = self._validate_world_point(
            transformer,
            prediction_input.current_circle_center,
        )
        team_area = self._validate_world_point(transformer, prediction_input.team_area)
        zone_config = self.config_service.get_zone_phases(map_id)
        phases = {phase["phase"]: phase for phase in zone_config["phases"]}
        self._validate_prediction_phase(prediction_input.current_phase, zone_config, phases)

        next_phase = prediction_input.current_phase + 1
        final_phase = int(zone_config["final_phase"])
        current_radius = float(phases[prediction_input.current_phase]["radius"])
        warnings: list[str] = []
        loaded_model = self._load_latest_model(map_id, warnings)
        next_circle = self._predict_circle(
            map_id=map_id,
            current_phase=prediction_input.current_phase,
            target_type="next",
            target_phase=next_phase,
            current_radius=current_radius,
            target_radius=float(phases[next_phase]["radius"]),
            current_center=current_center,
            transformer=transformer,
            loaded_model=loaded_model,
            fallback_shift=0.25,
            warnings=warnings,
        )
        final_circle = self._predict_circle(
            map_id=map_id,
            current_phase=prediction_input.current_phase,
            target_type="final",
            target_phase=final_phase,
            current_radius=current_radius,
            target_radius=float(phases[final_phase]["radius"]),
            current_center=current_center,
            transformer=transformer,
            loaded_model=loaded_model,
            fallback_shift=0.6,
            warnings=warnings,
        )
        hotspot_summary, hotspot_lookup = self._hotspot_summary(
            map_id,
            prediction_input.current_phase,
        )
        warnings.extend(hotspot_summary.warnings)
        route = self._build_route(
            strategy=prediction_input.route_strategy,
            team_area=team_area,
            next_circle=next_circle,
            final_circle=final_circle,
            transformer=transformer,
            hotspot_lookup=hotspot_lookup,
            hotspot_available=hotspot_summary.available,
            warnings=warnings,
        )
        explanation = self._explain(
            prediction_input=prediction_input,
            map_id=map_id,
            next_circle=next_circle,
            final_circle=final_circle,
            route=route,
            hotspot_summary=hotspot_summary,
            model_run_id=loaded_model.run_id if loaded_model else None,
            warnings=warnings,
        )
        return PredictionResult(
            map_id=map_id,
            current_phase=prediction_input.current_phase,
            next_circle=next_circle,
            final_circle=final_circle,
            route=route,
            hotspot_summary=hotspot_summary,
            explanation=explanation,
            model_run_id=loaded_model.run_id if loaded_model else None,
            warnings=_dedupe(warnings),
        )

    def _load_latest_model(self, map_id: str, warnings: list[str]) -> LoadedModel | None:
        rows = self.repo.fetch_all(
            """
            SELECT mr.id, mr.maps_included, mr.model_path,
                   AVG(mm.mean_center_error) AS validation_error
            FROM model_runs mr
            LEFT JOIN model_metrics mm
              ON mm.model_run_id = mr.id
             AND mm.split = 'validation'
            WHERE mr.status = 'completed' AND mr.model_path IS NOT NULL
            GROUP BY mr.id
            ORDER BY
                CASE WHEN validation_error IS NULL THEN 1 ELSE 0 END ASC,
                validation_error ASC,
                mr.created_at DESC,
                mr.id DESC
            """
        )
        candidate_warnings: list[str] = []
        found_candidate = False
        for row in rows:
            maps_included = _loads_list(row["maps_included"])
            if map_id not in maps_included:
                continue
            found_candidate = True
            row_warnings: list[str] = []
            loaded_model = self._load_model_from_row(row, row_warnings)
            if loaded_model is not None:
                return loaded_model
            candidate_warnings.extend(row_warnings)
        if not found_candidate:
            warnings.extend(["model_not_ready", "rule_baseline_used"])
            return None
        warnings.extend(
            _dedupe(candidate_warnings or ["model_artifact_unavailable", "rule_baseline_used"])
        )
        return None

    def _load_model_from_row(
        self,
        selected_row: sqlite3.Row,
        warnings: list[str],
    ) -> LoadedModel | None:
        model_path = Path(selected_row["model_path"])
        if not model_path.is_absolute():
            model_path = self.model_dir / model_path
        try:
            payload = json.loads(model_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            warnings.extend(["model_artifact_unavailable", "rule_baseline_used"])
            return None

        if payload.get("schema_version", 1) != SUPPORTED_MODEL_SCHEMA_VERSION:
            warnings.extend(["model_artifact_invalid", "rule_baseline_used"])
            return None
        if payload.get("algorithm", "statistical_mean_offset_v1") not in SUPPORTED_MODEL_ALGORITHMS:
            warnings.extend(["model_artifact_invalid", "rule_baseline_used"])
            return None
        groups_payload = payload.get("groups")
        if not isinstance(groups_payload, list):
            warnings.extend(["model_artifact_invalid", "rule_baseline_used"])
            return None

        groups: dict[tuple[str, int, str], ModelGroup] = {}
        for item in groups_payload:
            if not isinstance(item, dict):
                continue
            try:
                group = ModelGroup(
                    map_id=str(item["map_id"]),
                    current_phase=int(item["current_phase"]),
                    target_type=str(item["target_type"]),
                    offset_x=float(item["offset_x"]),
                    offset_y=float(item["offset_y"]),
                    sample_count=int(item.get("sample_count", 0)),
                )
            except (KeyError, TypeError, ValueError):
                warnings.append("model_group_invalid")
                continue
            groups[(group.map_id, group.current_phase, group.target_type)] = group

        feature_grid_size = None
        feature_groups: dict[tuple[str, int, str, int, int], FeatureModelGroup] = {}
        feature_model = payload.get("feature_model")
        if isinstance(feature_model, dict):
            try:
                feature_grid_size = int(feature_model.get("grid_size", 0))
            except (TypeError, ValueError):
                feature_grid_size = None
            feature_groups_payload = feature_model.get("groups")
            if feature_grid_size and isinstance(feature_groups_payload, list):
                for item in feature_groups_payload:
                    if not isinstance(item, dict):
                        continue
                    try:
                        feature_group = FeatureModelGroup(
                            map_id=str(item["map_id"]),
                            current_phase=int(item["current_phase"]),
                            target_type=str(item["target_type"]),
                            cell_x=int(item["cell_x"]),
                            cell_y=int(item["cell_y"]),
                            offset_x=float(item["offset_x"]),
                            offset_y=float(item["offset_y"]),
                            sample_count=int(item.get("sample_count", 0)),
                        )
                    except (KeyError, TypeError, ValueError):
                        warnings.append("feature_model_group_invalid")
                        continue
                    feature_groups[
                        (
                            feature_group.map_id,
                            feature_group.current_phase,
                            feature_group.target_type,
                            feature_group.cell_x,
                            feature_group.cell_y,
                        )
                    ] = feature_group
        return LoadedModel(
            run_id=selected_row["id"],
            groups=groups,
            feature_grid_size=feature_grid_size,
            feature_groups=feature_groups,
        )

    def _predict_circle(
        self,
        *,
        map_id: str,
        current_phase: int,
        target_type: str,
        target_phase: int,
        current_radius: float,
        target_radius: float,
        current_center: Point,
        transformer: CoordinateTransformer,
        loaded_model: LoadedModel | None,
        fallback_shift: float,
        warnings: list[str],
    ) -> PredictedCircle:
        group = None
        feature_group = None
        if loaded_model is not None:
            feature_group = self._feature_group_for_point(
                transformer=transformer,
                loaded_model=loaded_model,
                map_id=map_id,
                current_phase=current_phase,
                target_type=target_type,
                point=current_center,
            )
            group = loaded_model.groups.get((map_id, current_phase, target_type))
            if feature_group is None and group is None:
                warnings.extend([f"model_group_missing:{target_type}", "rule_baseline_used"])
        if feature_group is not None:
            center = self._constrain_target_circle_center(
                transformer,
                current_center,
                current_radius,
                Point(
                    x=current_center.x + feature_group.offset_x,
                    y=current_center.y + feature_group.offset_y,
                ),
                target_radius,
            )
            return PredictedCircle(
                phase=target_phase,
                center=center,
                radius=target_radius,
                source="feature_model",
                sample_count=feature_group.sample_count,
            )
        if group is not None:
            center = self._constrain_target_circle_center(
                transformer,
                current_center,
                current_radius,
                Point(x=current_center.x + group.offset_x, y=current_center.y + group.offset_y),
                target_radius,
            )
            return PredictedCircle(
                phase=target_phase,
                center=center,
                radius=target_radius,
                source="model_artifact",
                sample_count=group.sample_count,
            )

        center = self._constrain_target_circle_center(
            transformer,
            current_center,
            current_radius,
            self._rule_baseline_center(transformer, current_center, fallback_shift),
            target_radius,
        )
        return PredictedCircle(
            phase=target_phase,
            center=center,
            radius=target_radius,
            source="rule_baseline",
            sample_count=None,
        )

    def _hotspot_summary(
        self,
        map_id: str,
        phase: int,
        grid_size: int = DEFAULT_GRID_SIZE,
    ) -> tuple[PredictionHotspotSummary, dict[tuple[int, int], float]]:
        latest = self.repo.fetch_one(
            """
            SELECT MAX(generated_at) AS generated_at
            FROM hotspot_tiles
            WHERE map_id = ? AND phase = ? AND grid_size = ?
            """,
            (map_id, phase, grid_size),
        )
        generated_at = latest["generated_at"] if latest else None
        if generated_at is None:
            return (
                PredictionHotspotSummary(
                    phase=phase,
                    available=False,
                    generated_at=None,
                    grid_size=grid_size,
                    top_tiles=[],
                    max_hotspot_score=0,
                    warnings=["hotspots_not_available"],
                ),
                {},
            )

        rows = self.repo.fetch_all(
            """
            SELECT tile_x, tile_y, density_score, kill_death_score, hotspot_score, sample_count
            FROM hotspot_tiles
            WHERE map_id = ? AND phase = ? AND grid_size = ? AND generated_at = ?
            ORDER BY hotspot_score DESC, tile_x ASC, tile_y ASC
            """,
            (map_id, phase, grid_size, generated_at),
        )
        tiles = [
            HotspotTileSummary(
                tile_x=row["tile_x"],
                tile_y=row["tile_y"],
                density_score=row["density_score"],
                kill_death_score=row["kill_death_score"],
                hotspot_score=row["hotspot_score"],
                sample_count=row["sample_count"],
            )
            for row in rows[:TOP_HOTSPOT_TILE_COUNT]
        ]
        hotspot_lookup = {(row["tile_x"], row["tile_y"]): row["hotspot_score"] for row in rows}
        return (
            PredictionHotspotSummary(
                phase=phase,
                available=True,
                generated_at=generated_at,
                grid_size=grid_size,
                top_tiles=tiles,
                max_hotspot_score=max(hotspot_lookup.values(), default=0),
            ),
            hotspot_lookup,
        )

    def _build_route(
        self,
        *,
        strategy: str,
        team_area: Point,
        next_circle: PredictedCircle,
        final_circle: PredictedCircle,
        transformer: CoordinateTransformer,
        hotspot_lookup: dict[tuple[int, int], float],
        hotspot_available: bool,
        warnings: list[str],
    ) -> RouteResult:
        if strategy == "center":
            target = next_circle.center
            waypoints = [team_area, target]
        elif strategy == "edge":
            target = self._edge_target(transformer, team_area, next_circle)
            waypoints = [team_area, target]
        elif strategy == "slow":
            target = self._edge_target(transformer, team_area, next_circle)
            observation = self._clamp_world_point(
                transformer,
                _interpolate(team_area, target, 0.45),
            )
            waypoints = [team_area, observation, target]
        else:
            if not hotspot_available:
                warnings.append("avoid_hotspots_without_hotspot_data")
            target, waypoints = self._avoid_hotspots_route(
                transformer=transformer,
                team_area=team_area,
                next_circle=next_circle,
                hotspot_lookup=hotspot_lookup,
            )

        distance = _polyline_distance(waypoints)
        hotspot_score = self._route_hotspot_score(transformer, waypoints, hotspot_lookup)
        route_score = self._route_score(
            strategy=strategy,
            distance=distance,
            hotspot_score=hotspot_score,
            transformer=transformer,
            target=target,
            final_circle=final_circle,
        )
        return RouteResult(
            strategy=strategy,
            target=target,
            waypoints=waypoints,
            route_score=route_score,
            risk_summary=RiskSummary(
                hotspot_risk=_risk_label(hotspot_score),
                hotspot_score=_round(hotspot_score),
                distance=_round(distance),
            ),
        )

    def _avoid_hotspots_route(
        self,
        *,
        transformer: CoordinateTransformer,
        team_area: Point,
        next_circle: PredictedCircle,
        hotspot_lookup: dict[tuple[int, int], float],
    ) -> tuple[Point, list[Point]]:
        target = self._edge_target(transformer, team_area, next_circle)
        midpoint = _interpolate(team_area, target, 0.5)
        dx = target.x - team_area.x
        dy = target.y - team_area.y
        length = sqrt(dx * dx + dy * dy) or 1
        perpendicular = Point(x=-dy / length, y=dx / length)
        offsets = [0, next_circle.radius * 0.6, -next_circle.radius * 0.6, next_circle.radius]
        candidates = [
            self._clamp_world_point(
                transformer,
                Point(
                    x=midpoint.x + perpendicular.x * offset,
                    y=midpoint.y + perpendicular.y * offset,
                ),
            )
            for offset in offsets
        ]
        best_midpoint = min(
            candidates,
            key=lambda candidate: (
                self._route_hotspot_score(
                    transformer,
                    [team_area, candidate, target],
                    hotspot_lookup,
                ),
                _polyline_distance([team_area, candidate, target]),
            ),
        )
        return target, [team_area, best_midpoint, target]

    def _route_score(
        self,
        *,
        strategy: str,
        distance: float,
        hotspot_score: float,
        transformer: CoordinateTransformer,
        target: Point,
        final_circle: PredictedCircle,
    ) -> float:
        diagonal = sqrt(
            (transformer.max_x - transformer.min_x) ** 2
            + (transformer.max_y - transformer.min_y) ** 2
        )
        distance_score = max(0.0, 1 - distance / diagonal)
        hotspot_component = 1 - hotspot_score
        final_distance = _distance(target, final_circle.center)
        final_score = max(0.0, 1 - final_distance / diagonal)
        if strategy == "avoid_hotspots":
            score = 0.35 * distance_score + 0.5 * hotspot_component + 0.15 * final_score
        elif strategy == "center":
            score = 0.45 * distance_score + 0.15 * hotspot_component + 0.4 * final_score
        elif strategy == "slow":
            score = 0.35 * distance_score + 0.25 * hotspot_component + 0.4 * final_score
        else:
            score = 0.5 * distance_score + 0.25 * hotspot_component + 0.25 * final_score
        return _round(min(max(score, 0), 1))

    def _route_hotspot_score(
        self,
        transformer: CoordinateTransformer,
        waypoints: list[Point],
        hotspot_lookup: dict[tuple[int, int], float],
    ) -> float:
        if not hotspot_lookup:
            return 0
        sample_points: list[Point] = []
        for start, end in zip(waypoints, waypoints[1:], strict=False):
            sample_points.extend(_interpolate(start, end, step / 4) for step in range(5))
        return max(
            (hotspot_lookup.get(_tile_for_point(transformer, point), 0) for point in sample_points),
            default=0,
        )

    def _explain(
        self,
        *,
        prediction_input: PredictionInput,
        map_id: str,
        next_circle: PredictedCircle,
        final_circle: PredictedCircle,
        route: RouteResult,
        hotspot_summary: PredictionHotspotSummary,
        model_run_id: str | None,
        warnings: list[str],
    ) -> ExplanationResult:
        rule_text = self._rule_explanation(
            prediction_input=prediction_input,
            next_circle=next_circle,
            final_circle=final_circle,
            route=route,
            hotspot_summary=hotspot_summary,
        )
        if not prediction_input.use_llm_explanation:
            return ExplanationResult(source="rule_fallback", text=rule_text)
        if not self.llm_settings.is_configured:
            warnings.append("llm_not_configured")
            return ExplanationResult(source="rule_fallback", text=rule_text)
        try:
            assert self.explanation_client is not None
            return ExplanationResult(
                source="llm",
                text=self.explanation_client.generate(
                    self._llm_prompt(
                        map_id=map_id,
                        prediction_input=prediction_input,
                        next_circle=next_circle,
                        final_circle=final_circle,
                        route=route,
                        hotspot_summary=hotspot_summary,
                        model_run_id=model_run_id,
                    ),
                    self.llm_settings,
                ),
            )
        except (LLMExplanationError, httpx.HTTPError, ValueError):
            warnings.append("llm_explanation_failed")
            return ExplanationResult(source="rule_fallback", text=rule_text)

    def _rule_explanation(
        self,
        *,
        prediction_input: PredictionInput,
        next_circle: PredictedCircle,
        final_circle: PredictedCircle,
        route: RouteResult,
        hotspot_summary: PredictionHotspotSummary,
    ) -> str:
        direction = _direction(prediction_input.current_circle_center, next_circle.center)
        hotspot_text = (
            f"历史热点风险为{route.risk_summary.hotspot_risk}。"
            if hotspot_summary.available
            else "当前阶段还没有可用热点数据，路线按距离和策略偏好降级生成。"
        )
        source_text = (
            "使用训练模型 artifact 的历史偏移。"
            if next_circle.source in {"feature_model", "model_artifact"}
            or final_circle.source in {"feature_model", "model_artifact"}
            else "未找到可用模型，使用规则基线兜底。"
        )
        strategy_text = {
            "edge": "贴边进圈，目标点偏向预测安全区边缘以减少多方向暴露。",
            "center": "抢中心，目标点靠近预测下一圈中心以争取后续圈位优势。",
            "slow": "慢进圈，先经过观察点再进入预测安全区。",
            "avoid_hotspots": "绕路避战，优先选择历史热点风险较低的转移线。",
        }[prediction_input.route_strategy]
        return (
            f"预测下一圈相对当前圈向{direction}收缩，{source_text}"
            f"推荐路线距离约 {route.risk_summary.distance:.0f} PUBG 坐标单位。"
            f"{strategy_text}{hotspot_text}"
        )

    def _llm_prompt(
        self,
        *,
        map_id: str,
        prediction_input: PredictionInput,
        next_circle: PredictedCircle,
        final_circle: PredictedCircle,
        route: RouteResult,
        hotspot_summary: PredictionHotspotSummary,
        model_run_id: str | None,
    ) -> str:
        return json.dumps(
            {
                "map_id": map_id,
                "current_phase": prediction_input.current_phase,
                "route_strategy": prediction_input.route_strategy,
                "prediction_sources": {
                    "next": next_circle.source,
                    "final": final_circle.source,
                    "model_run_id": model_run_id,
                },
                "next_circle": _circle_summary(next_circle),
                "final_circle": _circle_summary(final_circle),
                "route": {
                    "distance": route.risk_summary.distance,
                    "hotspot_risk": route.risk_summary.hotspot_risk,
                    "route_score": route.route_score,
                },
                "hotspots": {
                    "available": hotspot_summary.available,
                    "top_tile_count": len(hotspot_summary.top_tiles),
                    "max_hotspot_score": hotspot_summary.max_hotspot_score,
                },
            },
            ensure_ascii=False,
        )

    @staticmethod
    def _validate_strategy(strategy: str) -> None:
        if strategy not in ROUTE_STRATEGIES:
            raise AppError(
                code="INVALID_ROUTE_STRATEGY",
                message=f"route_strategy must be one of {sorted(ROUTE_STRATEGIES)}",
                details={"route_strategy": strategy},
            )

    @staticmethod
    def _validate_prediction_phase(
        current_phase: int,
        zone_config: dict[str, Any],
        phases: dict[int, dict[str, Any]],
    ) -> None:
        supported = [int(phase) for phase in zone_config["supported_prediction_phases"]]
        final_phase = int(zone_config["final_phase"])
        if (
            current_phase not in supported
            or current_phase + 1 not in phases
            or final_phase not in phases
        ):
            raise AppError(
                code="INVALID_PHASE",
                message=f"current_phase must be one of {supported}",
                details={"current_phase": current_phase, "supported_prediction_phases": supported},
            )

    @staticmethod
    def _validate_world_point(transformer: CoordinateTransformer, point: Point) -> Point:
        transformer.world_to_normalized(point, clamp=False)
        return point

    @staticmethod
    def _clamp_world_point(transformer: CoordinateTransformer, point: Point) -> Point:
        normalized = transformer.world_to_normalized(point, clamp=True)
        return transformer.normalized_to_world(normalized, clamp=True)

    @staticmethod
    def _feature_group_for_point(
        *,
        transformer: CoordinateTransformer,
        loaded_model: LoadedModel,
        map_id: str,
        current_phase: int,
        target_type: str,
        point: Point,
    ) -> FeatureModelGroup | None:
        if not loaded_model.feature_grid_size:
            return None
        normalized = transformer.world_to_normalized(point, clamp=True)
        cell_x = min(
            loaded_model.feature_grid_size - 1,
            max(0, int(normalized.x * loaded_model.feature_grid_size)),
        )
        cell_y = min(
            loaded_model.feature_grid_size - 1,
            max(0, int(normalized.y * loaded_model.feature_grid_size)),
        )
        return loaded_model.feature_groups.get(
            (map_id, current_phase, target_type, cell_x, cell_y)
        )

    @staticmethod
    def _constrain_target_circle_center(
        transformer: CoordinateTransformer,
        current_center: Point,
        current_radius: float,
        target_center: Point,
        target_radius: float,
    ) -> Point:
        clamped_target = PredictionService._clamp_world_point(transformer, target_center)
        max_distance = max(0.0, current_radius - target_radius)
        dx = clamped_target.x - current_center.x
        dy = clamped_target.y - current_center.y
        distance = sqrt(dx * dx + dy * dy)
        if distance <= max_distance or distance == 0:
            return clamped_target
        scale = max_distance / distance
        return PredictionService._clamp_world_point(
            transformer,
            Point(
                x=current_center.x + dx * scale,
                y=current_center.y + dy * scale,
            ),
        )

    @staticmethod
    def _rule_baseline_center(
        transformer: CoordinateTransformer,
        current_center: Point,
        shift: float,
    ) -> Point:
        map_center = Point(
            x=(transformer.min_x + transformer.max_x) / 2,
            y=(transformer.min_y + transformer.max_y) / 2,
        )
        return PredictionService._clamp_world_point(
            transformer,
            _interpolate(current_center, map_center, shift),
        )

    @staticmethod
    def _edge_target(
        transformer: CoordinateTransformer,
        team_area: Point,
        next_circle: PredictedCircle,
    ) -> Point:
        dx = team_area.x - next_circle.center.x
        dy = team_area.y - next_circle.center.y
        length = sqrt(dx * dx + dy * dy) or 1
        return PredictionService._clamp_world_point(
            transformer,
            Point(
                x=next_circle.center.x + dx / length * next_circle.radius * 0.75,
                y=next_circle.center.y + dy / length * next_circle.radius * 0.75,
            ),
        )


def _chat_completions_url(base_url: str) -> str:
    url = base_url.rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    if url.endswith("/v1"):
        return f"{url}/chat/completions"
    return f"{url}/v1/chat/completions"


def _tile_for_point(
    transformer: CoordinateTransformer,
    point: Point,
    grid_size: int = DEFAULT_GRID_SIZE,
) -> tuple[int, int]:
    normalized = transformer.world_to_normalized(point, clamp=True)
    tile_x = min(int(normalized.x * grid_size), grid_size - 1)
    tile_y = min(int(normalized.y * grid_size), grid_size - 1)
    return tile_x, tile_y


def _interpolate(start: Point, end: Point, ratio: float) -> Point:
    return Point(x=start.x + (end.x - start.x) * ratio, y=start.y + (end.y - start.y) * ratio)


def _distance(start: Point, end: Point) -> float:
    return sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2)


def _polyline_distance(points: list[Point]) -> float:
    return sum(_distance(start, end) for start, end in zip(points, points[1:], strict=False))


def _risk_label(score: float) -> str:
    if score < 0.25:
        return "low"
    if score < 0.6:
        return "medium"
    return "high"


def _direction(start: Point, end: Point) -> str:
    dx = end.x - start.x
    dy = end.y - start.y
    horizontal = "东" if dx > 0 else "西"
    vertical = "南" if dy > 0 else "北"
    if abs(dx) < 1 and abs(dy) < 1:
        return "中心附近"
    if abs(dx) < abs(dy) * 0.35:
        return vertical
    if abs(dy) < abs(dx) * 0.35:
        return horizontal
    return f"{vertical}{horizontal}"


def _circle_summary(circle: PredictedCircle) -> dict[str, object]:
    return {
        "phase": circle.phase,
        "center": {"x": _round(circle.center.x), "y": _round(circle.center.y)},
        "radius": _round(circle.radius),
        "source": circle.source,
        "sample_count": circle.sample_count,
    }


def _loads_list(value: str) -> list[Any]:
    parsed = json.loads(value)
    return parsed if isinstance(parsed, list) else []


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            result.append(value)
            seen.add(value)
    return result


def _round(value: float) -> float:
    return round(value, 6)
