from app.api.training import get_training_service
from app.main import app
from app.services.training import ModelMetric, ModelRun
from fastapi.testclient import TestClient


def _run() -> ModelRun:
    return ModelRun(
        id="model-test",
        created_at="2026-06-05T00:00:00+00:00",
        maps_included=["erangel"],
        phases_included=[1],
        sample_count=5,
        algorithm="statistical_mean_offset_v1",
        model_path="/tmp/model-test.json",
        status="completed",
        metrics=[
            ModelMetric(
                split="validation",
                map_id="erangel",
                current_phase=1,
                target_type="next",
                sample_count=5,
                mean_center_error=10,
                median_center_error=8,
                p90_center_error=20,
            )
        ],
        warnings=[],
    )


class FakeTrainingService:
    def train_baseline(self, map_id: str | None = None) -> ModelRun:
        assert map_id == "erangel"
        return _run()

    def list_runs(self, limit: int = 20) -> list[ModelRun]:
        assert limit == 10
        return [_run()]

    def get_run(self, run_id: str) -> ModelRun:
        assert run_id == "model-test"
        return _run()

    def get_metrics(self, run_id: str) -> list[ModelMetric]:
        assert run_id == "model-test"
        return _run().metrics


def test_train_model_run_api_returns_run_metrics_and_warnings() -> None:
    app.dependency_overrides[get_training_service] = lambda: FakeTrainingService()
    client = TestClient(app)
    try:
        response = client.post("/api/training/runs", params={"map_id": "erangel"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "model-test"
    assert body["sample_count"] == 5
    assert body["metrics"][0]["split"] == "validation"
    assert body["metrics"][0]["target_type"] == "next"
    assert body["warnings"] == []


def test_list_model_runs_api_returns_runs() -> None:
    app.dependency_overrides[get_training_service] = lambda: FakeTrainingService()
    client = TestClient(app)
    try:
        response = client.get("/api/training/runs", params={"limit": 10})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["runs"][0]["id"] == "model-test"


def test_get_model_run_api_returns_metrics() -> None:
    app.dependency_overrides[get_training_service] = lambda: FakeTrainingService()
    client = TestClient(app)
    try:
        response = client.get("/api/training/runs/model-test")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["metrics"][0]["mean_center_error"] == 10


def test_get_model_metrics_api_returns_metrics_only() -> None:
    app.dependency_overrides[get_training_service] = lambda: FakeTrainingService()
    client = TestClient(app)
    try:
        response = client.get("/api/training/runs/model-test/metrics")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == "model-test"
    assert body["metrics"][0]["p90_center_error"] == 20
