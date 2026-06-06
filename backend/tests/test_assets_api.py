from pathlib import Path

from app.api.assets import get_asset_manager
from app.main import app
from app.services.assets import AssetManager
from app.services.config_service import ConfigService
from fastapi.testclient import TestClient

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + (b"0" * 300)


def test_map_asset_metadata_api_reports_cache_state(tmp_path: Path) -> None:
    cached = tmp_path / "Assets/Maps/Erangel_Main_High_Res.png"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(PNG_BYTES)

    def override_asset_manager() -> AssetManager:
        return AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    app.dependency_overrides[get_asset_manager] = override_asset_manager
    client = TestClient(app)
    try:
        response = client.get("/api/assets/maps/erangel")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["cached"] is True
    assert body["relative_path"] == "Assets/Maps/Erangel_Main_High_Res.png"
    assert body["asset_key"] == "high"


def test_map_asset_image_requires_valid_cache(tmp_path: Path) -> None:
    def override_asset_manager() -> AssetManager:
        return AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    app.dependency_overrides[get_asset_manager] = override_asset_manager
    client = TestClient(app)
    try:
        response = client.get("/api/assets/maps/erangel/image")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ASSET_UNAVAILABLE"
