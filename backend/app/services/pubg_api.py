from __future__ import annotations

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

    def _get_json(self, path: str, *, authenticated: bool) -> dict[str, Any]:
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
                response = client.get(path, headers=headers)
                response.raise_for_status()
                payload = response.json()
            except httpx.HTTPError as exc:
                raise AppError(
                    code="PUBG_API_REQUEST_FAILED",
                    message="PUBG API request failed",
                    status_code=502,
                    details={"path": path, "reason": str(exc)},
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
