import { useRef, useEffect, useState } from "react";
import { Point } from "./TacticalPrediction";
import { PredictResponse } from "../api";

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
}

const MAP_VIEW_SIZE = 1000;

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
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });
  const [hasDragged, setHasDragged] = useState(false);
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      const h = entries[0].contentRect.height;
      setMapSize({ w, h });
      
      setTransform(prev => {
        if (prev.scale === 1) return prev;
        const minX = w * (1 - prev.scale);
        const minY = h * (1 - prev.scale);
        const newX = Math.max(minX, Math.min(prev.x, 0));
        const newY = Math.max(minY, Math.min(prev.y, 0));
        return { ...prev, x: newX, y: newY };
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
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (newScale === 1) {
      setTransform({ x: 0, y: 0, scale: 1 });
    } else {
      let newX = mouseX - (mouseX - transform.x) * (newScale / transform.scale);
      let newY = mouseY - (mouseY - transform.y) * (newScale / transform.scale);
      
      const minX = mapSize.w * (1 - newScale);
      const minY = mapSize.h * (1 - newScale);
      newX = Math.max(minX, Math.min(newX, 0));
      newY = Math.max(minY, Math.min(newY, 0));

      setTransform({ x: newX, y: newY, scale: newScale });
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
        
        const minX = mapSize.w * (1 - transform.scale);
        const minY = mapSize.h * (1 - transform.scale);
        newX = Math.max(minX, Math.min(newX, 0));
        newY = Math.max(minY, Math.min(newY, 0));

        setTransform(prev => ({
          ...prev,
          x: newX,
          y: newY
        }));
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
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const x = ((mouseX - transform.x) / transform.scale / rect.width) * MAP_VIEW_SIZE;
    const y = ((mouseY - transform.y) / transform.scale / rect.height) * MAP_VIEW_SIZE;
    
    onClick({
      x: Math.max(0, Math.min(MAP_VIEW_SIZE, x)),
      y: Math.max(0, Math.min(MAP_VIEW_SIZE, y)),
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
        className="absolute inset-0 origin-top-left"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        {/* Background Map Image */}
        <img 
          src={mapImageUrl}
          alt={`${selectedMap} map base`}
          className="absolute inset-0 w-full h-full object-cover pointer-events-none opacity-80 mix-blend-normal"
        />

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
             <circle cx={zoneCenter.x} cy={zoneCenter.y} r={4} fill="#3b82f6" />
             <text x={zoneCenter.x + 10} y={zoneCenter.y + 4} fill="#3b82f6" fontSize="12" className="drop-shadow-md">阶段 {zoneStage}</text>
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
                 strokeWidth="3"
                 strokeDasharray={strategy === 'avoid' ? "8 5" : "6 6"}
                 className="drop-shadow-md"
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
            <circle cx={teamPos.x} cy={teamPos.y} r={6} fill="#22c55e" stroke="#14532d" strokeWidth="2" />
            <circle cx={teamPos.x} cy={teamPos.y} r={12} fill="none" stroke="#22c55e" strokeWidth="1" className="animate-ping" style={{ transformOrigin: `${teamPos.x}px ${teamPos.y}px` }} />
            <text x={teamPos.x + 10} y={teamPos.y + 4} fill="#22c55e" fontSize="12" fontWeight="bold" className="drop-shadow-md">队伍</text>
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
    </div>
  );
}
