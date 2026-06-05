from app.main import app
from fastapi.testclient import TestClient


def test_health_check_returns_service_status() -> None:
    client = TestClient(app)

    response = client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "PUBG Zone Predictor"
    assert body["version"] == "0.1.0"
    assert body["environment"] == "local"
    assert body["config_dir"].endswith("/config")
