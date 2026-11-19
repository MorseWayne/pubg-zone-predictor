from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.errors import AppError

JSON_HEADERS = {"Accept": "application/vnd.api+json"}
TELEMETRY_HEADERS = {"Accept": "application/vnd.api+json", "Accept-Encoding": "gzip"}


@dataclass(frozen=True)
class PubgApiClient:
    api_key: str | None
    base_url: str = "https://api.pubg.com"
    timeout_seconds: int = 30
    transport: httpx.BaseTransport | None = None

    def get_tournaments(self) -> dict[str, Any]:
        return self._get_json("/tournaments", authenticated=True)

    def get_tournament(self, tournament_id: str) -> dict[str, Any]:
        return self._get_json(f"/tournaments/{tournament_id}", authenticated=True)

    def get_tournament_match(self, match_id: str) -> dict[str, Any]:
        return self._get_json(f"/shards/tournament/matches/{match_id}", authenticated=False)

    def get_match_samples(self, platform: str) -> dict[str, Any]:
        return self._get_json(f"/shards/{_path_segment(platform)}/samples", authenticated=True)

    def get_players_by_names(self, platform: str, player_names: list[str]) -> dict[str, Any]:
        names = [_player_name(name) for name in player_names]
        if not names:
            raise AppError(
                code="PUBG_PLAYER_NAMES_REQUIRED",
                message="at least one player name is required",
                status_code=400,
            )
        return self._get_json(
            f"/shards/{_path_segment(platform)}/players",
            authenticated=True,
            params={"filter[playerNames]": ",".join(names)},
        )

    def get_season_batch(
        self,
        platform: str,
        season: str,
        mode: str,
        ids: list[str],
    ) -> dict[str, Any]:
        return self._get_json(
            f"/shards/{_path_segment(platform)}/seasons/{_path_segment(season)}"
            f"/gameMode/{_path_segment(mode)}/players",
            authenticated=True,
            params={"filter[playerIds]": ",".join(ids)},
        )

    def get_ranked_stats(self, platform: str, season: str, player_id: str) -> dict[str, Any]:
        return self._get_json(
            f"/shards/{_path_segment(platform)}/players/{_path_segment(player_id)}"
            f"/seasons/{_path_segment(season)}/ranked",
            authenticated=True,
        )

    def get_survival_mastery(self, platform: str, player_id: str) -> dict[str, Any]:
        return self._get_json(
            f"/shards/{_path_segment(platform)}/players/{_path_segment(player_id)}/survival_mastery",
            authenticated=True,
        )

    def get_match(self, match_id: str, platform: str) -> dict[str, Any]:
        return self._get_json(
            f"/shards/{_path_segment(platform)}/matches/{_path_segment(match_id)}",
            authenticated=False,
        )

    def download_telemetry(self, telemetry_url: str) -> bytes:
        with self._client() as client:
            try:
                response = client.get(telemetry_url, headers=TELEMETRY_HEADERS)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise AppError(
                    code="PUBG_API_REQUEST_FAILED",
                    message="PUBG telemetry request failed",
                    status_code=502,
                    details={"url": telemetry_url, "reason": str(exc)},
                ) from exc
        return response.content

    def _get_json(
        self,
        path: str,
        *,
        authenticated: bool,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        headers = dict(JSON_HEADERS)
        if authenticated:
            if not self.api_key:
                raise AppError(
                    code="PUBG_API_KEY_MISSING",
                    message="PUBG_API_KEY is required for this ingest operation",
                    status_code=400,
                )
            headers["Authorization"] = f"Bearer {self.api_key}"

        with self._client() as client:
            try:
                response = client.get(path, headers=headers, params=params)
                if response.status_code == 429:
                    reset = response.headers.get("X-RateLimit-Reset", "")
                    wait = int(reset) - int(time.time()) + 1 if reset.isdigit() else 60
                    raise AppError(
                        "PUBG_RATE_LIMIT",
                        "PUBG API 配额暂时用尽",
                        429,
                        {"retry_after": max(1, min(3600, wait))},
                    )
                response.raise_for_status()
                payload = response.json()
            except httpx.HTTPError as exc:
                raise AppError(
                    code="PUBG_API_REQUEST_FAILED",
                    message="PUBG API request failed",
                    status_code=502,
                    details={
                        "path": path,
                        "reason": str(exc),
                        "upstream_status": exc.response.status_code
                        if isinstance(exc, httpx.HTTPStatusError)
                        else None,
                    },
                ) from exc
            except ValueError as exc:
                raise AppError(
                    code="PUBG_API_RESPONSE_INVALID",
                    message="PUBG API returned invalid JSON",
                    status_code=502,
                    details={"path": path},
                ) from exc

        if not isinstance(payload, dict):
            raise AppError(
                code="PUBG_API_RESPONSE_INVALID",
                message="PUBG API response must be a JSON object",
                status_code=502,
                details={"path": path},
            )
        return payload

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.base_url.rstrip("/"),
            timeout=self.timeout_seconds,
            follow_redirects=True,
            transport=self.transport,
        )


def _path_segment(value: str) -> str:
    normalized = value.strip()
    if not normalized or "/" in normalized:
        raise AppError(
            code="PUBG_API_PATH_INVALID",
            message="PUBG API path segment must be non-empty and cannot contain '/'",
            status_code=400,
            details={"value": value},
        )
    return normalized


def _player_name(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise AppError(
            code="PUBG_PLAYER_NAME_INVALID",
            message="player name must be non-empty",
            status_code=400,
            details={"value": value},
        )
    return normalized
