from __future__ import annotations

import hashlib
import math
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.errors import AppError
from app.services.pubg_cache import PLAYER_TTL, PubgCache

JSON_HEADERS = {"Accept": "application/vnd.api+json"}
TELEMETRY_HEADERS = {"Accept": "application/vnd.api+json", "Accept-Encoding": "gzip"}


@dataclass(frozen=True)
class PubgApiClient:
    api_key: str | None
    base_url: str = "https://api.pubg.com"
    timeout_seconds: int = 30
    transport: httpx.BaseTransport | None = None
    cache: PubgCache | None = None

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
        platform = _path_segment(platform)

        def request(missing: list[str]) -> dict:
            return self._get_json(
                f"/shards/{platform}/players",
                authenticated=True,
                params={"filter[playerNames]": ",".join(missing)},
            )

        if self.cache is None:
            return request(names)
        cache = self.cache
        spelling = {name.casefold(): name for name in names}

        def fetch(keys: list[str]) -> dict:
            players = request([spelling[key] for key in keys])["data"]
            by_id = {p["id"]: p for p in players}
            _forget_renamed_aliases(cache, platform, by_id)
            cache.write(f"{platform}/players/id", by_id, PLAYER_TTL)
            return {p["attributes"]["name"].casefold(): p for p in players}

        rows = cache.resolve(f"{platform}/players/name", list(spelling), PLAYER_TTL, fetch)
        return {"data": [rows[key] for key in spelling if rows[key] is not None]}

    def get_player_by_id(
        self,
        platform: str,
        account_id: str,
        *,
        refresh: bool = False,
    ) -> dict[str, Any]:
        if not re.fullmatch(r"account\.[a-zA-Z0-9_-]{1,64}", account_id):
            raise AppError("PUBG_ACCOUNT_ID_INVALID", "Steam 游戏账号 ID 格式不正确", 400)
        platform = _path_segment(platform)
        path = f"/shards/{platform}/players/{account_id}"
        if self.cache is None:
            return self._get_json(path, authenticated=True)
        cache = self.cache

        def fetch(_ids: list[str]) -> dict:
            player = self._get_json(path, authenticated=True)["data"]
            if player["id"] != account_id:
                raise AppError("PUBG_API_RESPONSE_INVALID", "返回的账号 ID 不一致", 502)
            name = player["attributes"]["name"].casefold()
            _forget_renamed_aliases(cache, platform, {account_id: player})
            cache.write(f"{platform}/players/name", {name: player}, PLAYER_TTL)
            return {account_id: player}

        rows = cache.resolve(
            f"{platform}/players/id", [account_id], PLAYER_TTL, fetch, force=refresh
        )
        if rows[account_id] is None:
            raise AppError(
                "PLAYER_NOT_FOUND", "未找到这个 Steam 账号", 404, {"upstream_status": 404}
            )
        return {"data": rows[account_id]}

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
        if authenticated and self.cache and self.api_key:
            quota_key = hashlib.sha256(self.api_key.encode()).hexdigest()
            with self.cache.fill_lock:
                reset = self.cache.read("quota", [quota_key]).get(quota_key)
                if reset is not None:
                    raise _rate_limited(reset - self.cache.clock())
                return self._request_json(path, authenticated, params, quota_key)
        return self._request_json(path, authenticated, params, None)

    def _request_json(
        self,
        path: str,
        authenticated: bool,
        params: dict[str, str] | None,
        quota_key: str | None,
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
                limited = response.status_code == 429
                if limited or (quota_key and response.headers.get("X-RateLimit-Remaining") == "0"):
                    now = self.cache.clock() if self.cache else time.time()
                    reset = response.headers.get("X-RateLimit-Reset", "")
                    retry = response.headers.get("Retry-After", "")
                    wait = int(reset) - now + 1 if reset.isdigit() else 60
                    if retry.isdigit():
                        wait = max(wait, int(retry)) if reset.isdigit() else int(retry)
                    wait = max(1, math.ceil(wait))
                    if self.cache and quota_key:
                        self.cache.write("quota", {quota_key: now + wait}, wait)
                    if limited:
                        raise _rate_limited(wait)
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


def _forget_renamed_aliases(cache: PubgCache, platform: str, players: dict) -> None:
    previous = cache.read(f"{platform}/players/id", players)
    for pid, player in players.items():
        if previous.get(pid):
            old = previous[pid]["attributes"]["name"].casefold()
            if old != player["attributes"]["name"].casefold():
                resource = f"{platform}/players/name"
                alias = cache.read(resource, [old]).get(old)
                if alias and alias["id"] == pid:
                    cache.forget(resource, old)


def _rate_limited(wait: float) -> AppError:
    return AppError(
        "PUBG_RATE_LIMIT", "PUBG API 配额暂时用尽", 429, {"retry_after": max(1, math.ceil(wait))}
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


def entity_attributes(entity: dict[str, Any]) -> dict[str, Any]:
    attributes = entity.get("attributes", {})
    return attributes if isinstance(attributes, dict) else {}


def entity_match_refs(tournament: dict[str, Any]) -> list[str]:
    relationships = tournament.get("relationships", {})
    matches = relationships.get("matches", {}) if isinstance(relationships, dict) else {}
    data = matches.get("data", []) if isinstance(matches, dict) else []
    return [item["id"] for item in data if isinstance(item, dict) and item.get("id")]


def match_attributes(payload: dict[str, Any]) -> dict[str, Any]:
    match = payload.get("data", {}) if isinstance(payload.get("data"), dict) else {}
    return entity_attributes(match)


def match_telemetry_url(payload: dict[str, Any]) -> str | None:
    included = payload.get("included", [])
    if not isinstance(included, list):
        return None
    for entity in included:
        if not isinstance(entity, dict):
            continue
        attributes = entity.get("attributes", {})
        if isinstance(attributes, dict) and attributes.get("URL"):
            return attributes["URL"]
    return None
