import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  canvasToMapPixel,
  clamp,
  clampZoom,
  createFitTransform,
  effectiveScale,
  mapPixelToCanvas,
  mapPixelToWorld,
  updateFitScaleKeepingCenter,
  worldToMapPixel,
  zoomAtCanvasPoint,
  type CoordinateConfig,
  type Point,
  type Size,
  type ViewTransform,
} from "../utils/mapCanvasTransforms";

type MapConfig = {
  map_id: string;
  display_name: string;
  world_size: number;
  coordinate: CoordinateConfig;
};

type ClickMode = "current_circle_center" | "team_area";

type PredictionResult = {
  next_circle: { center: Point; radius: number };
  final_circle: { center: Point; radius: number };
  route: { waypoints: Point[] };
  hotspot_summary: {
    grid_size: number;
    top_tiles: Array<{ tile_x: number; tile_y: number; hotspot_score: number }>;
  };
};

type InteractiveMapCanvasProps = {
  map: MapConfig;
  imageUrl: string | null;
  enabled: boolean;
  currentPhaseRadius: number;
  currentCircleCenter: Point | null;
  teamArea: Point | null;
  prediction: PredictionResult | null;
  clickMode: ClickMode;
  onSetCurrentCircleCenter: (point: Point) => void;
  onSetTeamArea: (point: Point) => void;
  onImageError: (message: string) => void;
};

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  moved: boolean;
};

const CLICK_MOVE_THRESHOLD = 4;
const WHEEL_ZOOM_FACTOR = 1.14;
const BUTTON_ZOOM_FACTOR = 1.2;

export function InteractiveMapCanvas({
  map,
  imageUrl,
  enabled,
  currentPhaseRadius,
  currentCircleCenter,
  teamArea,
  prediction,
  clickMode,
  onSetCurrentCircleCenter,
  onSetTeamArea,
  onImageError,
}: InteractiveMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const previousCanvasSizeRef = useRef<Size | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [canvasSize, setCanvasSize] = useState<Size>({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState<Size | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [transform, setTransform] = useState<ViewTransform | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const canInteract = enabled && imageReady && Boolean(imageSize) && Boolean(transform);
  const zoomLabel = transform ? `${transform.zoom.toFixed(2)}×` : "1.00×";

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    function updateSize() {
      const rect = container?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setCanvasSize({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) });
    }

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    window.addEventListener("resize", updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    function handleDprChange() {
      setCanvasSize((size) => ({ ...size }));
    }

    const mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mediaQuery.addEventListener("change", handleDprChange);
    return () => mediaQuery.removeEventListener("change", handleDprChange);
  }, [canvasSize.width, canvasSize.height]);

  useEffect(() => {
    setImageReady(false);
    setImageSize(null);
    imageRef.current = null;
    setTransform(null);

    if (!imageUrl) {
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) {
        return;
      }
      imageRef.current = image;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
      setImageReady(true);
    };
    image.onerror = () => {
      if (!cancelled) {
        onImageError("地图图片解码失败");
      }
    };
    image.src = imageUrl;

    return () => {
      cancelled = true;
    };
  }, [imageUrl, onImageError]);

  useEffect(() => {
    if (!imageSize || canvasSize.width <= 0 || canvasSize.height <= 0) {
      return;
    }

    const previousCanvasSize = previousCanvasSizeRef.current;
    setTransform((current) => {
      if (!current || !previousCanvasSize) {
        return createFitTransform(imageSize, canvasSize);
      }
      return updateFitScaleKeepingCenter(current, imageSize, previousCanvasSize, canvasSize);
    });
    previousCanvasSizeRef.current = canvasSize;
  }, [canvasSize, imageSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvasSize.width * dpr);
    canvas.height = Math.round(canvasSize.height * dpr);
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    context.fillStyle = "#030810";
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);

    if (!image || !imageSize || !transform) {
      drawEmptyState(context, canvasSize, imageUrl ? "地图加载中…" : "等待地图资源");
      return;
    }

    drawMap(context, image, imageSize, transform);
    drawHotspots(context, prediction, imageSize, transform);
    drawCircles(context, map, currentPhaseRadius, currentCircleCenter, prediction, imageSize, transform);
    drawRoute(context, map, prediction, imageSize, transform);
    drawMarkers(context, map, currentCircleCenter, teamArea, imageSize, transform);
  }, [canvasSize, currentCircleCenter, currentPhaseRadius, imageReady, imageSize, imageUrl, map, prediction, teamArea, transform]);

  function resetView() {
    if (!imageSize) {
      return;
    }
    setTransform(createFitTransform(imageSize, canvasSize));
  }

  function zoomBy(factor: number) {
    setTransform((current) => {
      if (!current) {
        return current;
      }
      return zoomAtCanvasPoint(current, { x: canvasSize.width / 2, y: canvasSize.height / 2 }, current.zoom * factor);
    });
  }

  function handleWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    if (!canInteract) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
    setTransform((current) => (current ? zoomAtCanvasPoint(current, anchor, current.zoom * factor) : current));
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!canInteract || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      moved: false,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const dragState = dragStateRef.current;
    if (!canInteract || !dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const totalDistance = Math.hypot(event.clientX - dragState.startClientX, event.clientY - dragState.startClientY);
    if (totalDistance > CLICK_MOVE_THRESHOLD) {
      dragState.moved = true;
      setIsDragging(true);
    }

    if (dragState.moved) {
      const deltaX = event.clientX - dragState.lastClientX;
      const deltaY = event.clientY - dragState.lastClientY;
      setTransform((current) => (current ? { ...current, offsetX: current.offsetX + deltaX, offsetY: current.offsetY + deltaY } : current));
    }

    dragState.lastClientX = event.clientX;
    dragState.lastClientY = event.clientY;
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    dragStateRef.current = null;
    setIsDragging(false);

    if (!canInteract || dragState.moved || !imageSize || !transform) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const canvasPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const mapPixel = canvasToMapPixel(canvasPoint, transform, imageSize);
    const worldPoint = mapPixelToWorld(mapPixel, map.coordinate, imageSize);
    if (clickMode === "current_circle_center") {
      onSetCurrentCircleCenter(worldPoint);
    } else {
      onSetTeamArea(worldPoint);
    }
  }

  function handlePointerCancel() {
    dragStateRef.current = null;
    setIsDragging(false);
  }

  const canvasClassName = useMemo(() => {
    const stateClass = canInteract ? (isDragging ? "dragging" : "interactive") : "disabled";
    return `interactive-map-canvas ${stateClass}`;
  }, [canInteract, isDragging]);

  return (
    <div className="interactive-map" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className={canvasClassName}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
        width={canvasSize.width}
        height={canvasSize.height}
        aria-label={`${map.display_name} 交互地图`}
      />
      <div className="map-hud" aria-label="地图缩放控制">
        <button type="button" disabled={!canInteract || transform?.zoom === MIN_ZOOM} onClick={() => zoomBy(1 / BUTTON_ZOOM_FACTOR)}>
          −
        </button>
        <span>{zoomLabel}</span>
        <button type="button" disabled={!canInteract || transform?.zoom === MAX_ZOOM} onClick={() => zoomBy(BUTTON_ZOOM_FACTOR)}>
          +
        </button>
        <button type="button" disabled={!canInteract} onClick={resetView}>
          重置
        </button>
      </div>
      <div className="map-help">单击标点 · 拖拽移动 · 滚轮缩放</div>
    </div>
  );
}

function drawEmptyState(context: CanvasRenderingContext2D, canvasSize: Size, label: string) {
  context.save();
  context.fillStyle = "rgba(230, 237, 243, 0.72)";
  context.font = "700 16px Inter, sans-serif";
  context.textAlign = "center";
  context.fillText(label, canvasSize.width / 2, canvasSize.height / 2);
  context.restore();
}

function drawMap(context: CanvasRenderingContext2D, image: HTMLImageElement, imageSize: Size, transform: ViewTransform) {
  const scale = effectiveScale(transform);
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, transform.offsetX, transform.offsetY, imageSize.width * scale, imageSize.height * scale);
  context.restore();
}

function drawHotspots(
  context: CanvasRenderingContext2D,
  prediction: PredictionResult | null,
  imageSize: Size,
  transform: ViewTransform,
) {
  if (!prediction || prediction.hotspot_summary.grid_size <= 0) {
    return;
  }

  const tileSize = 1 / prediction.hotspot_summary.grid_size;
  context.save();
  for (const tile of prediction.hotspot_summary.top_tiles) {
    const topLeft = mapPixelToCanvas(
      { x: tile.tile_x * tileSize * imageSize.width, y: tile.tile_y * tileSize * imageSize.height },
      transform,
    );
    const bottomRight = mapPixelToCanvas(
      { x: (tile.tile_x + 1) * tileSize * imageSize.width, y: (tile.tile_y + 1) * tileSize * imageSize.height },
      transform,
    );
    context.fillStyle = `rgba(255, 123, 114, ${0.18 + tile.hotspot_score * 0.42})`;
    context.strokeStyle = "rgba(255, 123, 114, 0.38)";
    context.lineWidth = 1;
    context.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    context.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  }
  context.restore();
}

function drawCircles(
  context: CanvasRenderingContext2D,
  map: MapConfig,
  currentPhaseRadius: number,
  currentCircleCenter: Point | null,
  prediction: PredictionResult | null,
  imageSize: Size,
  transform: ViewTransform,
) {
  if (currentCircleCenter) {
    drawCircle(context, map, currentCircleCenter, currentPhaseRadius, imageSize, transform, "当前圈", "#58a6ff", []);
  }
  if (prediction) {
    drawCircle(context, map, prediction.next_circle.center, prediction.next_circle.radius, imageSize, transform, "下一圈", "#7ee787", [8, 8]);
    drawCircle(context, map, prediction.final_circle.center, prediction.final_circle.radius, imageSize, transform, "最终圈", "#d2a8ff", [5, 7]);
  }
}

function drawCircle(
  context: CanvasRenderingContext2D,
  map: MapConfig,
  center: Point,
  radius: number,
  imageSize: Size,
  transform: ViewTransform,
  label: string,
  color: string,
  dash: number[],
) {
  const centerPixel = worldToMapPixel(center, map.coordinate, imageSize);
  const centerCanvas = mapPixelToCanvas(centerPixel, transform);
  const radiusPixel = (radius / (map.coordinate.max_x - map.coordinate.min_x)) * imageSize.width;
  const radiusCanvas = radiusPixel * effectiveScale(transform);

  context.save();
  context.beginPath();
  context.arc(centerCanvas.x, centerCanvas.y, radiusCanvas, 0, Math.PI * 2);
  context.setLineDash(dash);
  context.lineWidth = clamp(2.4 / Math.sqrt(transform.zoom), 1.4, 3.2);
  context.strokeStyle = color;
  context.fillStyle = `${color}1f`;
  context.fill();
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "rgba(7, 17, 31, 0.78)";
  context.strokeStyle = "rgba(0, 0, 0, 0.45)";
  context.lineWidth = 3;
  const textWidth = context.measureText(label).width + 16;
  context.beginPath();
  context.roundRect(centerCanvas.x - textWidth / 2, centerCanvas.y - 13, textWidth, 24, 12);
  context.fill();
  context.stroke();
  context.fillStyle = color;
  context.font = "800 12px Inter, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, centerCanvas.x, centerCanvas.y);
  context.restore();
}

function drawRoute(
  context: CanvasRenderingContext2D,
  map: MapConfig,
  prediction: PredictionResult | null,
  imageSize: Size,
  transform: ViewTransform,
) {
  const waypoints = prediction?.route.waypoints ?? [];
  if (waypoints.length < 2) {
    return;
  }

  context.save();
  context.beginPath();
  waypoints.forEach((waypoint, index) => {
    const point = mapPixelToCanvas(worldToMapPixel(waypoint, map.coordinate, imageSize), transform);
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });
  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = "rgba(7, 17, 31, 0.86)";
  context.lineWidth = 7;
  context.stroke();
  context.strokeStyle = "#f2cc60";
  context.lineWidth = 3;
  context.stroke();
  context.restore();
}

function drawMarkers(
  context: CanvasRenderingContext2D,
  map: MapConfig,
  currentCircleCenter: Point | null,
  teamArea: Point | null,
  imageSize: Size,
  transform: ViewTransform,
) {
  if (currentCircleCenter) {
    drawMarker(context, map, currentCircleCenter, imageSize, transform, "圈心", "#58a6ff");
  }
  if (teamArea) {
    drawMarker(context, map, teamArea, imageSize, transform, "队伍", "#f2cc60");
  }
}

function drawMarker(
  context: CanvasRenderingContext2D,
  map: MapConfig,
  point: Point,
  imageSize: Size,
  transform: ViewTransform,
  label: string,
  color: string,
) {
  const canvasPoint = mapPixelToCanvas(worldToMapPixel(point, map.coordinate, imageSize), transform);
  context.save();
  context.translate(canvasPoint.x, canvasPoint.y);
  context.fillStyle = color;
  context.strokeStyle = "rgba(7, 17, 31, 0.9)";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(0, -16, 13, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(-7, -7);
  context.lineTo(0, 5);
  context.lineTo(7, -7);
  context.closePath();
  context.fill();
  context.stroke();
  context.fillStyle = "#07111f";
  context.font = "900 11px Inter, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 0, -16);
  context.restore();
}
