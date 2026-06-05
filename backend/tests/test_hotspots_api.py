from app.api.hotspots import get_hotspot_service
from app.main import app
from app.services.hotspots import HotspotResult, HotspotSummary, HotspotTile
from fastapi.testclient import TestClient


def _result() -> HotspotResult:
    return HotspotResult(
        map_id="erangel",
        phase=1,
        grid_size=64,
        generated_at="2026-06-05T00:00:00+00:00",
        summary=HotspotSummary(
            effective_match_count=2,
            effective_team_count=3,
            tile_count=1,
            max_sample_count=2,
        ),
        tiles=[
            HotspotTile(
                tile_x=0,
                tile_y=0,
                density_score=1,
                kill_death_score=0,
                hotspot_score=0.8,
                sample_count=2,
            )
        ],
        warnings=["low effective match count: 2 < 10"],
    )


class FakeHotspotService:
    def generate_hotspots(self, map_id: str, phase: int, grid_size: int) -> HotspotResult:
        assert map_id == "erangel"
        assert phase == 1
        assert grid_size == 64
        return _result()

    def get_latest_hotspots(self, map_id: str, phase: int, grid_size: int) -> HotspotResult:
        assert map_id == "erangel"
        assert phase == 1
        assert grid_size == 64
        return _result()


def test_generate_hotspots_api_returns_tiles_and_summary() -> None:
    app.dependency_overrides[get_hotspot_service] = lambda: FakeHotspotService()
    client = TestClient(app)
    try:
        response = client.post("/api/hotspots/generate", params={"map_id": "erangel", "phase": 1})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["tile_count"] == 1
    assert body["tiles"][0]["hotspot_score"] == 0.8
    assert body["warnings"] == ["low effective match count: 2 < 10"]


def test_get_hotspots_api_returns_latest_batch() -> None:
    app.dependency_overrides[get_hotspot_service] = lambda: FakeHotspotService()
    client = TestClient(app)
    try:
        response = client.get("/api/hotspots", params={"map_id": "erangel", "phase": 1})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["generated_at"] == "2026-06-05T00:00:00+00:00"
