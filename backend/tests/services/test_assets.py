from pathlib import Path

import httpx
import pytest
from app.core.errors import AppError
from app.services.assets import AssetManager
from app.services.config_service import ConfigService

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + (b"0" * 300)


def test_map_asset_metadata_uses_configured_relative_path(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    metadata = manager.get_map_asset_metadata("erangel")

    assert metadata.map_id == "erangel"
    assert metadata.asset_key == "high"
    assert metadata.relative_path == "Assets/Maps/Erangel_Main_High_Res.png"
    assert metadata.cached is False
    assert metadata.image_url == "/api/assets/maps/erangel/image?asset_key=high"


def test_png_validation_rejects_lfs_pointer_sized_file(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")
    pointer = tmp_path / "pointer.png"
    pointer.write_text("version https://git-lfs.github.com/spec/v1", encoding="utf-8")

    assert manager.is_valid_png(pointer) is False


def test_ensure_uses_valid_cache_without_download(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")
    cached = tmp_path / "Assets/Maps/Erangel_Main_High_Res.png"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(PNG_BYTES)

    asset = manager.ensure_map_asset("erangel")

    assert asset.cached is True
    assert asset.downloaded is False
    assert asset.local_path == cached

def test_high_res_request_does_not_fall_back_to_low_res_cache(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")
    cached_low = tmp_path / "Assets/Maps/Erangel_Main_Low_Res.png"
    cached_low.parent.mkdir(parents=True)
    cached_low.write_bytes(PNG_BYTES)

    with pytest.raises(AppError) as exc_info:
        manager.ensure_map_asset("erangel", "high")

    assert exc_info.value.code == "ASSET_UNAVAILABLE"
    assert exc_info.value.details["asset_key"] == "high"


def test_miramar_high_res_metadata_uses_desert_asset_path(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    metadata = manager.get_map_asset_metadata("miramar")

    assert metadata.map_id == "miramar"
    assert metadata.asset_key == "high"
    assert metadata.relative_path == "Assets/Maps/Miramar_Main_High_Res.png"
    assert metadata.image_url == "/api/assets/maps/miramar/image?asset_key=high"


def test_explicit_low_res_request_can_use_low_res_cache(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")
    cached_low = tmp_path / "Assets/Maps/Erangel_Main_Low_Res.png"
    cached_low.parent.mkdir(parents=True)
    cached_low.write_bytes(PNG_BYTES)

    asset = manager.ensure_map_asset("erangel", "low")

    assert asset.asset_key == "low"
    assert asset.local_path == cached_low
    assert asset.cached is True


def test_download_import_error_is_reported_as_app_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    def raise_import_error(*_args: object, **_kwargs: object) -> httpx.Client:
        raise ImportError("Using SOCKS proxy, but the 'socksio' package is not installed.")

    monkeypatch.setattr(httpx, "Client", raise_import_error)

    with pytest.raises(AppError) as exc_info:
        manager.ensure_map_asset("erangel")

    assert exc_info.value.code == "ASSET_UNAVAILABLE"
    assert exc_info.value.status_code == 503
    assert "socksio" in (exc_info.value.details["last_error"] or "")


def test_invalid_asset_path_is_rejected(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    with pytest.raises(AppError) as exc_info:
        manager._validate_relative_path("../secret.png")

    assert exc_info.value.code == "INVALID_ASSET_PATH"
