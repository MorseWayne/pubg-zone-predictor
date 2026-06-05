from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.schemas import CoordinateConvertRequest
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.services.config_service import ConfigService
from app.services.coordinates import CoordinateTransformer, ImageSize, Point

router = APIRouter(prefix="/api/config", tags=["config"])
SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_config_service(settings: SettingsDep) -> ConfigService:
    return ConfigService(settings.config_dir)


ConfigServiceDep = Annotated[ConfigService, Depends(get_config_service)]


@router.get("/maps")
def list_maps(config_service: ConfigServiceDep) -> dict[str, object]:
    return {"maps": config_service.list_maps()}


@router.get("/zone-phases")
def get_zone_phases(
    map_id: str,
    config_service: ConfigServiceDep,
    game_mode: str = "default",
) -> dict[str, object]:
    return config_service.get_zone_phases(map_id=map_id, game_mode=game_mode)


@router.post("/maps/{map_id}/coordinates/convert")
def convert_coordinate(
    map_id: str,
    request: CoordinateConvertRequest,
    config_service: ConfigServiceDep,
) -> dict[str, object]:
    transformer = CoordinateTransformer.from_map_config(config_service.get_map(map_id))
    source_point = Point(x=request.point.x, y=request.point.y)
    image_size = (
        ImageSize(width=request.image_size.width, height=request.image_size.height)
        if request.image_size
        else None
    )

    normalized = _to_normalized(
        transformer,
        request.source,
        source_point,
        image_size,
        request.clamp,
    )
    converted = _from_normalized(transformer, request.target, normalized, image_size, request.clamp)
    response: dict[str, object] = {
        "map_id": map_id.lower(),
        "source": request.source,
        "target": request.target,
        "point": {"x": converted.x, "y": converted.y},
    }
    if request.clamp and (normalized.x in {0, 1} or normalized.y in {0, 1}):
        response["warnings"] = ["coordinate may have been clamped to map bounds"]
    return response


@router.get("/llm-status")
def get_llm_status(settings: SettingsDep) -> dict[str, object]:
    return {
        "enabled": settings.llm_enabled,
        "configured": bool(settings.llm_enabled and settings.llm_api_key and settings.llm_model),
        "base_url_configured": bool(settings.llm_base_url),
        "model": settings.llm_model if settings.llm_enabled else None,
        "timeout_seconds": settings.llm_timeout_seconds,
    }


def _to_normalized(
    transformer: CoordinateTransformer,
    source: str,
    point: Point,
    image_size: ImageSize | None,
    clamp: bool,
) -> Point:
    if source == "world":
        return transformer.world_to_normalized(point, clamp=clamp)
    if source == "normalized":
        return transformer._validate_or_clamp_normalized(point, clamp=clamp)
    if source == "pixel":
        if image_size is None:
            raise AppError(
                code="IMAGE_SIZE_REQUIRED",
                message="image_size is required when source is pixel",
            )
        return transformer.pixel_to_normalized(point, image_size, clamp=clamp)
    raise AppError(
        code="INVALID_COORDINATE_SPACE",
        message="source must be one of: world, normalized, pixel",
        details={"source": source},
    )


def _from_normalized(
    transformer: CoordinateTransformer,
    target: str,
    point: Point,
    image_size: ImageSize | None,
    clamp: bool,
) -> Point:
    if target == "world":
        return transformer.normalized_to_world(point, clamp=clamp)
    if target == "normalized":
        return transformer._validate_or_clamp_normalized(point, clamp=clamp)
    if target == "pixel":
        if image_size is None:
            raise AppError(
                code="IMAGE_SIZE_REQUIRED",
                message="image_size is required when target is pixel",
            )
        return transformer.normalized_to_pixel(point, image_size, clamp=clamp)
    raise AppError(
        code="INVALID_COORDINATE_SPACE",
        message="target must be one of: world, normalized, pixel",
        details={"target": target},
    )
