import httpx
import pytest
from app.core.errors import AppError
from app.services.pubg_api import PubgApiClient


def test_pubg_api_client_adds_authorization_for_tournaments() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/tournaments"
        assert request.headers["Authorization"] == "Bearer test-key"
        assert request.headers["Accept"] == "application/vnd.api+json"
        return httpx.Response(200, json={"data": []})

    client = PubgApiClient(
        api_key="test-key",
        base_url="https://api.pubg.test",
        transport=httpx.MockTransport(handler),
    )

    assert client.get_tournaments() == {"data": []}


def test_pubg_api_client_requires_api_key_for_authenticated_calls() -> None:
    client = PubgApiClient(api_key=None, base_url="https://api.pubg.test")

    with pytest.raises(AppError) as exc_info:
        client.get_tournaments()

    assert exc_info.value.code == "PUBG_API_KEY_MISSING"


def test_pubg_api_client_fetches_tournament_match_without_api_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/shards/tournament/matches/match-1"
        assert "Authorization" not in request.headers
        return httpx.Response(200, json={"data": {"id": "match-1"}})

    client = PubgApiClient(
        api_key=None,
        base_url="https://api.pubg.test",
        transport=httpx.MockTransport(handler),
    )

    assert client.get_tournament_match("match-1") == {"data": {"id": "match-1"}}


def test_pubg_api_client_downloads_telemetry_bytes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://telemetry.test/match-1.json"
        return httpx.Response(200, content=b"[]")

    client = PubgApiClient(
        api_key=None,
        base_url="https://api.pubg.test",
        transport=httpx.MockTransport(handler),
    )

    assert client.download_telemetry("https://telemetry.test/match-1.json") == b"[]"
