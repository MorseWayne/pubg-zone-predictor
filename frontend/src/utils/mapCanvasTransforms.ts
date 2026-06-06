export type Point = { x: number; y: number };

export type Size = { width: number; height: number };

export type CoordinateConfig = {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  y_axis?: "down" | "up";
};

export type ViewTransform = {
  fitScale: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
};

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

export function normalizedToWorld(point: Point, coordinate: CoordinateConfig): Point {
  const normalizedY = coordinate.y_axis === "up" ? 1 - point.y : point.y;
  return {
    x: coordinate.min_x + point.x * (coordinate.max_x - coordinate.min_x),
    y: coordinate.min_y + normalizedY * (coordinate.max_y - coordinate.min_y),
  };
}

export function worldToNormalized(point: Point, coordinate: CoordinateConfig): Point {
  const normalizedX = (point.x - coordinate.min_x) / (coordinate.max_x - coordinate.min_x);
  const rawY = (point.y - coordinate.min_y) / (coordinate.max_y - coordinate.min_y);
  const normalizedY = coordinate.y_axis === "up" ? 1 - rawY : rawY;
  return { x: clamp01(normalizedX), y: clamp01(normalizedY) };
}

export function normalizedToMapPixel(point: Point, imageSize: Size): Point {
  return { x: point.x * imageSize.width, y: point.y * imageSize.height };
}

export function mapPixelToNormalized(point: Point, imageSize: Size): Point {
  return { x: clamp01(point.x / imageSize.width), y: clamp01(point.y / imageSize.height) };
}

export function worldToMapPixel(point: Point, coordinate: CoordinateConfig, imageSize: Size): Point {
  return normalizedToMapPixel(worldToNormalized(point, coordinate), imageSize);
}

export function mapPixelToWorld(point: Point, coordinate: CoordinateConfig, imageSize: Size): Point {
  return normalizedToWorld(mapPixelToNormalized(point, imageSize), coordinate);
}

export function effectiveScale(transform: ViewTransform): number {
  return transform.fitScale * transform.zoom;
}

export function mapPixelToCanvas(point: Point, transform: ViewTransform): Point {
  const scale = effectiveScale(transform);
  return {
    x: transform.offsetX + point.x * scale,
    y: transform.offsetY + point.y * scale,
  };
}

export function canvasToMapPixel(point: Point, transform: ViewTransform, imageSize: Size): Point {
  const scale = effectiveScale(transform);
  return {
    x: clamp((point.x - transform.offsetX) / scale, 0, imageSize.width),
    y: clamp((point.y - transform.offsetY) / scale, 0, imageSize.height),
  };
}

export function createFitTransform(imageSize: Size, viewportSize: Size): ViewTransform {
  const fitScale = Math.min(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height);
  return {
    fitScale,
    zoom: 1,
    offsetX: (viewportSize.width - imageSize.width * fitScale) / 2,
    offsetY: (viewportSize.height - imageSize.height * fitScale) / 2,
  };
}

export function zoomAtCanvasPoint(transform: ViewTransform, anchor: Point, nextZoom: number): ViewTransform {
  const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const currentScale = effectiveScale(transform);
  const anchorMapPixel = {
    x: (anchor.x - transform.offsetX) / currentScale,
    y: (anchor.y - transform.offsetY) / currentScale,
  };
  const nextScale = transform.fitScale * clampedZoom;
  return {
    ...transform,
    zoom: clampedZoom,
    offsetX: anchor.x - anchorMapPixel.x * nextScale,
    offsetY: anchor.y - anchorMapPixel.y * nextScale,
  };
}

export function updateFitScaleKeepingCenter(
  transform: ViewTransform,
  imageSize: Size,
  previousViewportSize: Size,
  nextViewportSize: Size,
): ViewTransform {
  const nextFitScale = Math.min(nextViewportSize.width / imageSize.width, nextViewportSize.height / imageSize.height);
  if (!Number.isFinite(transform.fitScale) || transform.fitScale <= 0) {
    return createFitTransform(imageSize, nextViewportSize);
  }

  const previousCenter = { x: previousViewportSize.width / 2, y: previousViewportSize.height / 2 };
  const centerMapPixel = canvasToMapPixel(previousCenter, transform, imageSize);
  const nextScale = nextFitScale * transform.zoom;
  return {
    fitScale: nextFitScale,
    zoom: transform.zoom,
    offsetX: nextViewportSize.width / 2 - centerMapPixel.x * nextScale,
    offsetY: nextViewportSize.height / 2 - centerMapPixel.y * nextScale,
  };
}

export function clampZoom(value: number): number {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
