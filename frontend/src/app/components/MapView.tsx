import { useRef, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Point, MapAssetStatus } from "./TacticalPrediction";
import type { PredictResponse } from "../api";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";

interface MapViewProps {
  selectedMap: string;
  mapMode: 'center' | 'team';
  zoneCenter: Point | null;
  teamPos: Point | null;
  onClick: (p: Point) => void;
  zoneStage: number;
  predState: 'idle' | 'loading' | 'success' | 'error';
  strategy: string;
  prediction: PredictResponse | null;
  worldSize: number;
  currentRadius: number;
  mapImageUrl: string;
  mapAssetStatus: MapAssetStatus;
  mapAssetProgress: number;
  mapAssetMessage: string;
  onMapImageLoad: () => void;
  onMapImageError: () => void;
  onRetryMapAsset: () => void;
}

const MAP_VIEW_SIZE = 1000;
const ZONE_MARKER_RADIUS = 2.5;
const TEAM_MARKER_RADIUS = 3.5;
const TEAM_MARKER_PULSE_RADIUS = 7;
const MARKER_LABEL_FONT_SIZE = 10;
const MARKER_LABEL_OFFSET = 7;

function worldToMapPoint(point: Point, worldSize: number): Point {
  return {
    x: (point.x / worldSize) * MAP_VIEW_SIZE,
    y: (point.y / worldSize) * MAP_VIEW_SIZE,
  };
}

function worldRadiusToMap(radius: number, worldSize: number) {
  return (radius / worldSize) * MAP_VIEW_SIZE;
}

export function MapView({
  selectedMap,
  mapMode,
  zoneCenter,
  teamPos,
  onClick,
  zoneStage,
  predState,
  strategy,
  prediction,
  worldSize,
  currentRadius,
  mapImageUrl,
  mapAssetStatus,
  mapAssetProgress,
  mapAssetMessage,
  onMapImageLoad,
  onMapImageError,
  onRetryMapAsset,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });
  const [hasDragged, setHasDragged] = useState(false);
  const [mapFrame, setMapFrame] = useState({ left: 0, top: 0, size: 0 });

  const clampTransform = (x: number, y: number, scale: number) => {
    const min = mapFrame.size * (1 - scale);
    return {
      x: Math.max(min, Math.min(x, 0)),
      y: Math.max(min, Math.min(y, 0)),
      scale,
    };
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      const h = entries[0].contentRect.height;
      const size = Math.min(w, h);
      setMapFrame({
        left: (w - size) / 2,
        top: (h - size) / 2,
        size,
      });

      setTransform(prev => {
        if (prev.scale === 1) return prev;
        const min = size * (1 - prev.scale);
        return {
          ...prev,
          x: Math.max(min, Math.min(prev.x, 0)),
          y: Math.max(min, Math.min(prev.y, 0)),
        };
      });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const scaleChange = e.deltaY < 0 ? 1.1 : 0.9;
    let newScale = transform.scale * scaleChange;
    newScale = Math.max(1, Math.min(newScale, 8));

    if (newScale === transform.scale) return;

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - mapFrame.left;
    const mouseY = e.clientY - rect.top - mapFrame.top;

    if (newScale === 1) {
      setTransform({ x: 0, y: 0, scale: 1 });
    } else {
      let newX = mouseX - (mouseX - transform.x) * (newScale / transform.scale);
      let newY = mouseY - (mouseY - transform.y) * (newScale / transform.scale);

      setTransform(clampTransform(newX, newY, newScale));
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setHasDragged(false);
    setDragStart({ mouseX: e.clientX, mouseY: e.clientY, startX: transform.x, startY: transform.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = Math.abs(e.clientX - dragStart.mouseX);
      const dy = Math.abs(e.clientY - dragStart.mouseY);
      if (dx > 3 || dy > 3) {
        setHasDragged(true);
      }
      if (transform.scale > 1) {
        let newX = dragStart.startX + (e.clientX - dragStart.mouseX);
        let newY = dragStart.startY + (e.clientY - dragStart.mouseY);

        setTransform(clampTransform(newX, newY, transform.scale));
      }
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleContainerClick = (e: React.MouseEvent) => {
    if (hasDragged) return;
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - mapFrame.left;
    const mouseY = e.clientY - rect.top - mapFrame.top;

    const x = ((mouseX - transform.x) / transform.scale / mapFrame.size) * MAP_VIEW_SIZE;
    const y = ((mouseY - transform.y) / transform.scale / mapFrame.size) * MAP_VIEW_SIZE;

    if (x < 0 || x > MAP_VIEW_SIZE || y < 0 || y > MAP_VIEW_SIZE) return;

    onClick({
      x,
      y,
    });
  };

  const zoneRadius = worldRadiusToMap(currentRadius, worldSize);
  const nextZoneCenter = prediction ? worldToMapPoint(prediction.next_circle.center, worldSize) : null;
  const finalZoneCenter = prediction ? worldToMapPoint(prediction.final_circle.center, worldSize) : null;
  const nextZoneRadius = prediction ? worldRadiusToMap(prediction.next_circle.radius, worldSize) : 0;
  const finalZoneRadius = prediction ? worldRadiusToMap(prediction.final_circle.radius, worldSize) : 0;
  const routePoints = prediction?.route.waypoints.map((point) => worldToMapPoint(point, worldSize)) ?? [];
  const routePath =
    routePoints.length >= 2
      ? routePoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")
      : null;

  return (
    <div 
      ref={containerRef} 
      className={`w-full h-full relative overflow-hidden bg-[#2a2d34] select-none ${isDragging && transform.scale > 1 ? 'cursor-grabbing' : 'cursor-crosshair'}`}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleContainerClick}
    >
      <div 
        className="absolute origin-top-left"
        style={{
          left: `${mapFrame.left}px`,
          top: `${mapFrame.top}px`,
          width: `${mapFrame.size}px`,
          height: `${mapFrame.size}px`,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        }}
      >
        {/* Background Map Image */}
        {mapImageUrl && (
          <img
            src={mapImageUrl}
            alt={`${selectedMap} map base`}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none opacity-80 mix-blend-normal"
            onLoad={onMapImageLoad}
            onError={onMapImageError}
          />
        )}

        <svg 
          width="100%" 
          height="100%" 
          viewBox={`0 0 ${MAP_VIEW_SIZE} ${MAP_VIEW_SIZE}`}
          preserveAspectRatio="none"
          className="absolute inset-0 pointer-events-none"
        >
        {/* Grid Overlay */}
        <defs>
          <pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" className="pointer-events-none" />

        {/* Current Zone */}
        {zoneCenter && (
          <g>
             <circle cx={zoneCenter.x} cy={zoneCenter.y} r={zoneRadius} fill="rgba(59, 130, 246, 0.1)" stroke="rgba(59, 130, 246, 0.5)" strokeWidth="2" />
             <circle cx={zoneCenter.x} cy={zoneCenter.y} r={ZONE_MARKER_RADIUS} fill="#3b82f6" />
             <text x={zoneCenter.x + MARKER_LABEL_OFFSET} y={zoneCenter.y + 3} fill="#3b82f6" fontSize={MARKER_LABEL_FONT_SIZE} className="drop-shadow-md">阶段 {zoneStage}</text>
          </g>
        )}

        {/* Prediction Layers */}
        {predState === 'success' && zoneCenter && nextZoneCenter && finalZoneCenter && teamPos && (
          <g className="animate-in fade-in duration-700">
             {/* Next Zone */}
             <circle cx={nextZoneCenter.x} cy={nextZoneCenter.y} r={nextZoneRadius} fill="none" stroke="rgba(255, 255, 255, 0.8)" strokeWidth="2" strokeDasharray="4 4" />
             
             {/* Final Zone Area */}
             <circle cx={finalZoneCenter.x} cy={finalZoneCenter.y} r={finalZoneRadius} fill="rgba(168, 85, 247, 0.3)" stroke="#a855f7" strokeWidth="2" />
             
             {routePath && (
               <path
                 d={routePath}
                 fill="none"
                 stroke="#f97316"
                 strokeWidth="1.5"
                 strokeDasharray={strategy === 'avoid' ? "8 5" : "6 6"}
                 className="drop-shadow-md animate-dash-flow"
               />
             )}

             {/* Hotspot rendering along route */}
             {prediction?.hotspot_summary.top_tiles.slice(0, 4).map((tile) => {
               const tileSize = MAP_VIEW_SIZE / prediction.hotspot_summary.grid_size;
               return (
                 <circle
                   key={`${tile.tile_x}-${tile.tile_y}`}
                   cx={(tile.tile_x + 0.5) * tileSize}
                   cy={(tile.tile_y + 0.5) * tileSize}
                   r={Math.max(16, tileSize * 0.75)}
                   fill="url(#heatmap)"
                   opacity={Math.max(0.25, tile.hotspot_score)}
                 />
               );
             })}
          </g>
        )}

        <defs>
          <radialGradient id="heatmap" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
            <stop offset="0%" stopColor="rgba(239, 68, 68, 0.8)" />
            <stop offset="50%" stopColor="rgba(239, 68, 68, 0.4)" />
            <stop offset="100%" stopColor="rgba(239, 68, 68, 0)" />
          </radialGradient>
        </defs>

        {/* Team Position */}
        {teamPos && (
          <g>
            <circle cx={teamPos.x} cy={teamPos.y} r={TEAM_MARKER_RADIUS} fill="#22c55e" stroke="#14532d" strokeWidth="1.25" />
            <circle cx={teamPos.x} cy={teamPos.y} r={TEAM_MARKER_PULSE_RADIUS} fill="none" stroke="#22c55e" strokeWidth="0.75" className="animate-ping" style={{ transformOrigin: `${teamPos.x}px ${teamPos.y}px` }} />
            <text x={teamPos.x + MARKER_LABEL_OFFSET} y={teamPos.y + 3} fill="#22c55e" fontSize={MARKER_LABEL_FONT_SIZE} fontWeight="bold" className="drop-shadow-md">队伍</text>
          </g>
        )}

      </svg>
      </div>
      
      {/* Loading Overlay */}
      {predState === 'loading' && (
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center pointer-events-none z-20">
          <div className="bg-neutral-900 p-6 rounded-xl border border-orange-500/30 flex flex-col items-center gap-4 shadow-2xl">
            <div className="w-12 h-12 border-4 border-neutral-700 border-t-orange-500 rounded-full animate-spin" />
            <div className="text-orange-400 font-medium tracking-wide">正在处理地形数据...</div>
            <div className="text-xs text-neutral-500">正在评估 12,400 个历史场景</div>
          </div>
        </div>
      )}

      {mapAssetStatus !== "ready" && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-[#202329]/85 backdrop-blur-sm"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="w-[min(420px,calc(100%-2rem))] rounded border border-white/10 bg-neutral-950/90 p-5 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded bg-orange-500/15">
                {mapAssetStatus === "loading" ? (
                  <>
                    <span className="absolute h-8 w-8 animate-ping rounded-full border border-orange-400/40" />
                    <span className="h-5 w-5 rounded-full border-2 border-orange-500/30 border-t-orange-400 animate-spin" />
                  </>
                ) : (
                  <RefreshCw className="h-5 w-5 text-orange-300" />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white">
                  {mapAssetStatus === "loading" ? "地图资源加载中" : "地图资源未就绪"}
                </div>
                <div className="mt-1 truncate text-xs text-neutral-400">{mapAssetMessage}</div>
              </div>
            </div>

            <Progress
              value={mapAssetProgress}
              className="h-2 bg-neutral-800 [&_[data-slot=progress-indicator]]:bg-orange-500"
            />
            <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
              <span>{mapAssetStatus === "loading" ? "缓存检查 / 下载 / 渲染" : "可重新触发后端下载"}</span>
              <span>{Math.round(mapAssetProgress)}%</span>
            </div>

            {mapAssetStatus === "error" && (
              <Button
                onClick={onRetryMapAsset}
                className="mt-4 h-9 w-full rounded border border-orange-500/40 bg-orange-600 text-white hover:bg-orange-500"
              >
                <RefreshCw className="w-4 h-4" />
                重新加载地图
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
