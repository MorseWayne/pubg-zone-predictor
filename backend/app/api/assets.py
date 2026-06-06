from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse

from app.api.config import get_config_service
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.services.assets import DEFAULT_ASSET_KEY, AssetManager, MapAsset
from app.services.config_service import ConfigService

router = APIRouter(prefix="/api/assets", tags=["assets"])
SettingsDep = Annotated[Settings, Depends(get_settings)]
ConfigServiceDep = Annotated[ConfigService, Depends(get_config_service)]


def get_asset_manager(
    settings: SettingsDep,
    config_service: ConfigServiceDep,
) -> AssetManager:
    return AssetManager(
        config_service=config_service,
        cache_dir=settings.assets_cache_dir,
        base_url=settings.assets_base_url,
        timeout_seconds=settings.assets_download_timeout_seconds,
    )


AssetManagerDep = Annotated[AssetManager, Depends(get_asset_manager)]


@router.get("/maps/{map_id}")
def get_map_asset(
    map_id: str,
    asset_manager: AssetManagerDep,
    asset_key: str = DEFAULT_ASSET_KEY,
) -> dict[str, object]:
    return _asset_response(asset_manager.get_map_asset_metadata(map_id, asset_key))


@router.post("/maps/{map_id}/ensure")
def ensure_map_asset(
    map_id: str,
    asset_manager: AssetManagerDep,
    asset_key: str = DEFAULT_ASSET_KEY,
) -> dict[str, object]:
    return _asset_response(asset_manager.ensure_map_asset(map_id, asset_key))


@router.get("/maps/{map_id}/image")
def get_map_asset_image(
    map_id: str,
    asset_manager: AssetManagerDep,
    asset_key: str = DEFAULT_ASSET_KEY,
) -> FileResponse:
    asset = asset_manager.get_map_asset_metadata(map_id, asset_key)
    if not asset.cached:
        raise AppError(
            code="ASSET_UNAVAILABLE",
            message="map asset is not cached; call ensure before requesting image",
            status_code=503,
            details={"map_id": map_id, "asset_key": asset_key},
        )
    filename = Path(asset.relative_path).name
    return FileResponse(asset.local_path, media_type="image/png", filename=filename)


def _asset_response(asset: MapAsset) -> dict[str, object]:
    return {
        "map_id": asset.map_id,
        "asset_key": asset.asset_key,
        "relative_path": asset.relative_path,
        "cached": asset.cached,
        "downloaded": asset.downloaded,
        "image_url": asset.image_url,
        "warnings": asset.warnings,
    }
