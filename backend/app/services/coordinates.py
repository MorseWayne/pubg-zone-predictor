from dataclasses import dataclass
from typing import Any

from app.core.errors import AppError


@dataclass(frozen=True)
class Point:
    x: float
    y: float


@dataclass(frozen=True)
class ImageSize:
    width: float
    height: float


@dataclass(frozen=True)
class CoordinateTransformer:
    min_x: float
    min_y: float
    max_x: float
    max_y: float
    y_axis: str = "down"

    @classmethod
    def from_map_config(cls, map_config: dict[str, Any]) -> "CoordinateTransformer":
        coordinate = map_config["coordinate"]
        return cls(
            min_x=float(coordinate["min_x"]),
            min_y=float(coordinate["min_y"]),
            max_x=float(coordinate["max_x"]),
            max_y=float(coordinate["max_y"]),
            y_axis=coordinate.get("y_axis", "down"),
        )

    def world_to_normalized(self, point: Point, *, clamp: bool = True) -> Point:
        if self.max_x <= self.min_x or self.max_y <= self.min_y:
            raise AppError(
                code="INVALID_MAP_COORDINATE_CONFIG",
                message="map coordinate bounds must have positive width and height",
                status_code=500,
            )

        normalized_x = (point.x - self.min_x) / (self.max_x - self.min_x)
        normalized_y = (point.y - self.min_y) / (self.max_y - self.min_y)
        if self.y_axis == "up":
            normalized_y = 1 - normalized_y

        return self._validate_or_clamp_normalized(Point(normalized_x, normalized_y), clamp=clamp)

    def normalized_to_world(self, point: Point, *, clamp: bool = True) -> Point:
        normalized = self._validate_or_clamp_normalized(point, clamp=clamp)
        normalized_y = 1 - normalized.y if self.y_axis == "up" else normalized.y
        return Point(
            x=self.min_x + normalized.x * (self.max_x - self.min_x),
            y=self.min_y + normalized_y * (self.max_y - self.min_y),
        )

    def world_to_pixel(self, point: Point, image_size: ImageSize, *, clamp: bool = True) -> Point:
        normalized = self.world_to_normalized(point, clamp=clamp)
        return self.normalized_to_pixel(normalized, image_size, clamp=clamp)

    def pixel_to_world(self, point: Point, image_size: ImageSize, *, clamp: bool = True) -> Point:
        normalized = self.pixel_to_normalized(point, image_size, clamp=clamp)
        return self.normalized_to_world(normalized, clamp=clamp)

    def normalized_to_pixel(
        self,
        point: Point,
        image_size: ImageSize,
        *,
        clamp: bool = True,
    ) -> Point:
        self._validate_image_size(image_size)
        normalized = self._validate_or_clamp_normalized(point, clamp=clamp)
        return Point(x=normalized.x * image_size.width, y=normalized.y * image_size.height)

    def pixel_to_normalized(
        self,
        point: Point,
        image_size: ImageSize,
        *,
        clamp: bool = True,
    ) -> Point:
        self._validate_image_size(image_size)
        return self._validate_or_clamp_normalized(
            Point(x=point.x / image_size.width, y=point.y / image_size.height),
            clamp=clamp,
        )

    @staticmethod
    def _validate_image_size(image_size: ImageSize) -> None:
        if image_size.width <= 0 or image_size.height <= 0:
            raise AppError(
                code="INVALID_IMAGE_SIZE",
                message="image width and height must be greater than zero",
                details={"width": image_size.width, "height": image_size.height},
            )

    @staticmethod
    def _validate_or_clamp_normalized(point: Point, *, clamp: bool) -> Point:
        if 0 <= point.x <= 1 and 0 <= point.y <= 1:
            return point
        if not clamp:
            raise AppError(
                code="COORDINATE_OUT_OF_RANGE",
                message="coordinate is outside of the configured map bounds",
                details={"x": point.x, "y": point.y},
            )
        return Point(x=min(max(point.x, 0), 1), y=min(max(point.y, 0), 1))
