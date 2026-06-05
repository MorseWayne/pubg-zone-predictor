from pathlib import Path

import pytest
from app.core.errors import AppError
from app.services.assets import AssetManager
from app.services.config_service import ConfigService

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + (b"0" * 300)


def test_map_asset_metadata_uses_configured_relative_path(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    metadata = manager.get_map_asset_metadata("erangel")

    assert metadata.map_id == "erangel"
    assert metadata.asset_key == "no_text_low"
    assert metadata.relative_path == "Assets/Maps/Erangel_Main_No_Text_Low_Res.png"
    assert metadata.cached is False
    assert metadata.image_url == "/api/assets/maps/erangel/image?asset_key=no_text_low"


def test_png_validation_rejects_lfs_pointer_sized_file(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")
    pointer = tmp_path / "pointer.png"
    pointer.write_text("version https://git-lfs.github.com/spec/v1", encoding="utf-8")

    assert manager.is_valid_png(pointer) is False


def test_ensure_uses_valid_cache_without_download(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")
    cached = tmp_path / "Assets/Maps/Erangel_Main_No_Text_Low_Res.png"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(PNG_BYTES)

    asset = manager.ensure_map_asset("erangel")

    assert asset.cached is True
    assert asset.downloaded is False
    assert asset.local_path == cached


def test_invalid_asset_path_is_rejected(tmp_path: Path) -> None:
    manager = AssetManager(ConfigService(Path("config")), tmp_path, "https://example.test/assets")

    with pytest.raises(AppError) as exc_info:
        manager._validate_relative_path("../secret.png")

    assert exc_info.value.code == "INVALID_ASSET_PATH"
