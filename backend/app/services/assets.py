from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from app.core.errors import AppError
from app.services.config_service import ConfigService

PNG_HEADER = b"\x89PNG\r\n\x1a\n"
MIN_REAL_PNG_BYTES = 256
DEFAULT_ASSET_KEY = "high"
GIT_LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"


@dataclass(frozen=True)
class MapAsset:
    map_id: str
    asset_key: str
    relative_path: str
    local_path: Path
    image_url: str
    cached: bool
    downloaded: bool = False
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AssetManager:
    config_service: ConfigService
    cache_dir: Path
    base_url: str
    timeout_seconds: int = 120

    def get_map_asset_metadata(self, map_id: str, asset_key: str = DEFAULT_ASSET_KEY) -> MapAsset:
        map_config = self.config_service.get_map(map_id)
        relative_path = self._asset_relative_path(map_config, asset_key)
        local_path = self._local_path(relative_path)
        return MapAsset(
            map_id=map_config["map_id"],
            asset_key=asset_key,
            relative_path=relative_path,
            local_path=local_path,
            image_url=f"/api/assets/maps/{map_config['map_id']}/image?asset_key={asset_key}",
            cached=self.is_valid_png(local_path),
        )

    def ensure_map_asset(self, map_id: str, asset_key: str = DEFAULT_ASSET_KEY) -> MapAsset:
        map_config = self.config_service.get_map(map_id)
        warnings: list[str] = []
        last_error: str | None = None

        for candidate_key in self._fallback_keys(asset_key):
            try:
                relative_path = self._asset_relative_path(map_config, candidate_key)
            except AppError as exc:
                last_error = exc.message
                continue

            local_path = self._local_path(relative_path)
            if self.is_valid_png(local_path):
                if candidate_key != asset_key:
                    warnings.append(
                        f"asset '{asset_key}' unavailable; fell back to '{candidate_key}'"
                    )
                return MapAsset(
                    map_id=map_config["map_id"],
                    asset_key=candidate_key,
                    relative_path=relative_path,
                    local_path=local_path,
                    image_url=(
                        f"/api/assets/maps/{map_config['map_id']}/image?asset_key={candidate_key}"
                    ),
                    cached=True,
                    warnings=warnings,
                )

            if local_path.exists():
                local_path.unlink()
                warnings.append(f"removed invalid cached asset '{candidate_key}'")

            try:
                self._download(relative_path, local_path)
            except AppError as exc:
                last_error = exc.message
                warnings.append(f"download failed for '{candidate_key}': {exc.message}")
                continue

            if self.is_valid_png(local_path):
                if candidate_key != asset_key:
                    warnings.append(
                        f"asset '{asset_key}' unavailable; fell back to '{candidate_key}'"
                    )
                return MapAsset(
                    map_id=map_config["map_id"],
                    asset_key=candidate_key,
                    relative_path=relative_path,
                    local_path=local_path,
                    image_url=(
                        f"/api/assets/maps/{map_config['map_id']}/image?asset_key={candidate_key}"
                    ),
                    cached=True,
                    downloaded=True,
                    warnings=warnings,
                )

            if local_path.exists():
                local_path.unlink()
            warnings.append(f"downloaded asset '{candidate_key}' failed PNG validation")

        raise AppError(
            code="ASSET_UNAVAILABLE",
            message="map asset is unavailable and no valid cache exists",
            status_code=503,
            details={"map_id": map_id, "asset_key": asset_key, "last_error": last_error},
        )

    def is_valid_png(self, path: Path) -> bool:
        if not path.exists() or not path.is_file():
            return False
        if path.stat().st_size < MIN_REAL_PNG_BYTES:
            return False
        with path.open("rb") as file:
            return file.read(len(PNG_HEADER)) == PNG_HEADER

    def _download(self, relative_path: str, local_path: Path) -> None:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        url = f"{self.base_url.rstrip('/')}/{quote(relative_path, safe='/')}"
        try:
            timeout = httpx.Timeout(self.timeout_seconds, connect=30)
            with httpx.Client(timeout=timeout, follow_redirects=True) as client:
                response = client.get(url)
                response.raise_for_status()
                content = response.content
                media_url = self._github_lfs_media_url(url)
                if content.startswith(GIT_LFS_POINTER_PREFIX) and media_url:
                    response = client.get(media_url)
                    response.raise_for_status()
                    content = response.content
        except ImportError as exc:
            raise AppError(
                code="ASSET_DOWNLOAD_FAILED",
                message=str(exc),
                status_code=503,
                details={"url": url},
            ) from exc
        except httpx.HTTPError as exc:
            raise AppError(
                code="ASSET_DOWNLOAD_FAILED",
                message=str(exc),
                status_code=503,
                details={"url": url},
            ) from exc
        local_path.write_bytes(content)

    def _asset_relative_path(self, map_config: dict[str, Any], asset_key: str) -> str:
        assets = map_config.get("assets", {})
        if asset_key not in assets:
            raise AppError(
                code="ASSET_NOT_CONFIGURED",
                message=f"asset_key '{asset_key}' is not configured",
                details={"asset_key": asset_key, "available": sorted(assets.keys())},
            )
        relative_path = assets[asset_key]
        self._validate_relative_path(relative_path)
        return relative_path

    def _local_path(self, relative_path: str) -> Path:
        return self.cache_dir / relative_path

    @staticmethod
    def _github_lfs_media_url(url: str) -> str | None:
        parsed = urlparse(url)
        if parsed.netloc != "raw.githubusercontent.com":
            return None
        path_parts = parsed.path.lstrip("/").split("/", 3)
        if len(path_parts) != 4:
            return None
        owner, repo, ref, relative_path = path_parts
        return f"https://media.githubusercontent.com/media/{owner}/{repo}/{ref}/{relative_path}"

    @staticmethod
    def _fallback_keys(asset_key: str) -> list[str]:
        if asset_key in {"high", "no_text_high"}:
            return [asset_key]
        candidates = [asset_key, "no_text_low", "low"]
        deduped: list[str] = []
        for key in candidates:
            if key not in deduped:
                deduped.append(key)
        return deduped

    @staticmethod
    def _validate_relative_path(relative_path: str) -> None:
        path = Path(relative_path)
        if path.is_absolute() or ".." in path.parts:
            raise AppError(
                code="INVALID_ASSET_PATH",
                message="asset paths must be relative paths inside the official asset tree",
                status_code=500,
                details={"relative_path": relative_path},
            )
