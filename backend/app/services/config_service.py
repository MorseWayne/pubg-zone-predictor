from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from app.core.errors import AppError


@dataclass(frozen=True)
class ConfigService:
    config_dir: Path

    def list_maps(self) -> list[dict[str, Any]]:
        maps = self._maps_config().get("maps", {})
        return [self._map_response(map_id, config) for map_id, config in sorted(maps.items())]

    def get_map(self, map_id: str) -> dict[str, Any]:
        maps = self._maps_config().get("maps", {})
        normalized_map_id = map_id.lower()
        if normalized_map_id not in maps:
            raise AppError(
                code="UNSUPPORTED_MAP",
                message=f"map_id '{map_id}' is not configured",
                details={"map_id": map_id},
            )
        return self._map_response(normalized_map_id, maps[normalized_map_id])

    def get_zone_phases(self, map_id: str, game_mode: str = "default") -> dict[str, Any]:
        config = self._zone_config().get("zone_phase_config", {})
        maps = config.get("maps", {})
        normalized_map_id = map_id.lower()
        if normalized_map_id not in maps:
            raise AppError(
                code="UNSUPPORTED_MAP",
                message=f"map_id '{map_id}' is not configured for zone phases",
                details={"map_id": map_id},
            )

        game_modes = maps[normalized_map_id].get("game_modes", {})
        selected_mode = game_mode if game_mode in game_modes else "default"
        if selected_mode not in game_modes:
            raise AppError(
                code="UNSUPPORTED_GAME_MODE",
                message=f"game_mode '{game_mode}' is not configured for map '{map_id}'",
                details={"map_id": map_id, "game_mode": game_mode},
            )

        defaults = config.get("defaults", {})
        mode_config = game_modes[selected_mode]
        final_phase = int(mode_config.get("final_phase", defaults.get("final_phase", 8)))
        supported_prediction_phases = mode_config.get(
            "supported_prediction_phases",
            defaults.get("supported_prediction_phases", [1, 2, 3, 4, 5, 6, 7]),
        )
        phases = []
        for phase, phase_config in sorted(
            mode_config.get("phases", {}).items(),
            key=lambda item: int(item[0]),
        ):
            phase_response = {
                "phase": int(phase),
                "radius": float(phase_config["radius"]),
                "label": phase_config.get("label", f"Zone {phase}"),
                "enabled": bool(phase_config.get("enabled", True)),
                "is_final_candidate": bool(phase_config.get("is_final_candidate", False)),
            }
            phases.append(phase_response)

        return {
            "map_id": normalized_map_id,
            "game_mode": selected_mode,
            "config_version": config.get("version", "unknown"),
            "final_phase": final_phase,
            "supported_prediction_phases": [int(phase) for phase in supported_prediction_phases],
            "phases": phases,
        }

    def _maps_config(self) -> dict[str, Any]:
        return self._read_yaml("maps.yaml")

    def _zone_config(self) -> dict[str, Any]:
        return self._read_yaml("zone_phases.yaml")

    def _read_yaml(self, filename: str) -> dict[str, Any]:
        path = self.config_dir / filename
        if not path.exists():
            raise AppError(
                code="CONFIG_NOT_FOUND",
                message=f"Config file '{filename}' was not found",
                status_code=500,
                details={"path": str(path)},
            )
        content = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(content, dict):
            raise AppError(
                code="CONFIG_INVALID",
                message=f"Config file '{filename}' must contain a mapping",
                status_code=500,
                details={"path": str(path)},
            )
        return content

    @staticmethod
    def _map_response(map_id: str, config: dict[str, Any]) -> dict[str, Any]:
        return {
            "map_id": map_id,
            "display_name": config["display_name"],
            "telemetry_names": list(config.get("telemetry_names", [])),
            "world_size": float(config["world_size"]),
            "coordinate": config["coordinate"],
            "assets": config["assets"],
        }
