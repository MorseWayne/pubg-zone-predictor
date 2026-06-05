from pydantic import BaseModel, Field


class PointPayload(BaseModel):
    x: float
    y: float


class ImageSizePayload(BaseModel):
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class CoordinateConvertRequest(BaseModel):
    source: str
    target: str
    point: PointPayload
    image_size: ImageSizePayload | None = None
    clamp: bool = True
