from app.api.predict import get_prediction_service
from app.main import app
from app.services.coordinates import Point
from app.services.prediction import (
    ExplanationResult,
    PredictedCircle,
    PredictionHotspotSummary,
    PredictionInput,
    PredictionResult,
    RiskSummary,
    RouteResult,
)
from fastapi.testclient import TestClient


class FakePredictionService:
    def predict(self, prediction_input: PredictionInput) -> PredictionResult:
        assert prediction_input.map_id == "erangel"
        assert prediction_input.current_phase == 1
        assert prediction_input.current_circle_center == Point(x=100000, y=100000)
        assert prediction_input.team_area == Point(x=80000, y=120000)
        assert prediction_input.route_strategy == "center"
        return PredictionResult(
            map_id="erangel",
            current_phase=1,
            next_circle=PredictedCircle(
                phase=2,
                center=Point(x=101000, y=102000),
                radius=230000,
                source="model_artifact",
                sample_count=5,
            ),
            final_circle=PredictedCircle(
                phase=8,
                center=Point(x=103000, y=104000),
                radius=7700,
                source="model_artifact",
                sample_count=5,
            ),
            route=RouteResult(
                strategy="center",
                target=Point(x=101000, y=102000),
                waypoints=[Point(x=80000, y=120000), Point(x=101000, y=102000)],
                route_score=0.8,
                risk_summary=RiskSummary(
                    hotspot_risk="low",
                    hotspot_score=0.1,
                    distance=27658.633371,
                ),
            ),
            hotspot_summary=PredictionHotspotSummary(
                phase=1,
                available=False,
                generated_at=None,
                grid_size=64,
                top_tiles=[],
                max_hotspot_score=0,
                warnings=["hotspots_not_available"],
            ),
            explanation=ExplanationResult(source="rule_fallback", text="规则解释"),
            model_run_id="model-test",
            warnings=["hotspots_not_available"],
        )


def test_predict_api_returns_prediction_payload() -> None:
    app.dependency_overrides[get_prediction_service] = lambda: FakePredictionService()
    client = TestClient(app)
    try:
        response = client.post(
            "/api/predict",
            json={
                "map_id": "erangel",
                "current_phase": 1,
                "current_circle_center": {"x": 100000, "y": 100000},
                "team_area": {"x": 80000, "y": 120000},
                "route_strategy": "center",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["map_id"] == "erangel"
    assert body["next_circle"]["source"] == "model_artifact"
    assert body["route"]["strategy"] == "center"
    assert body["explanation"]["source"] == "rule_fallback"
    assert body["warnings"] == ["hotspots_not_available"]


def test_predict_api_validates_request_shape() -> None:
    client = TestClient(app)

    response = client.post(
        "/api/predict",
        json={
            "map_id": "erangel",
            "current_phase": 0,
            "current_circle_center": {"x": 100000, "y": 100000},
            "team_area": {"x": 80000, "y": 120000},
            "route_strategy": "center",
        },
    )

    assert response.status_code == 422
