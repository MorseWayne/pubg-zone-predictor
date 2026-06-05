import pytest
from app.core.errors import AppError
from app.services.coordinates import CoordinateTransformer, ImageSize, Point


def test_world_to_pixel_uses_map_bounds() -> None:
    transformer = CoordinateTransformer(min_x=0, min_y=0, max_x=816000, max_y=816000)

    pixel = transformer.world_to_pixel(Point(408000, 204000), ImageSize(width=1024, height=1024))

    assert pixel == Point(512, 256)


def test_pixel_to_world_round_trip() -> None:
    transformer = CoordinateTransformer(min_x=0, min_y=0, max_x=816000, max_y=816000)

    world = transformer.pixel_to_world(Point(512, 256), ImageSize(width=1024, height=1024))

    assert world == Point(408000, 204000)


def test_out_of_range_can_raise_or_clamp() -> None:
    transformer = CoordinateTransformer(min_x=0, min_y=0, max_x=100, max_y=100)

    with pytest.raises(AppError) as exc_info:
        transformer.world_to_normalized(Point(150, 50), clamp=False)

    assert exc_info.value.code == "COORDINATE_OUT_OF_RANGE"
    assert transformer.world_to_normalized(Point(150, 50), clamp=True) == Point(1, 0.5)
