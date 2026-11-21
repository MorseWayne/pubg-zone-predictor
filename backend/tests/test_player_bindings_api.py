from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from app.api.player_bindings import router
from app.core.config import Settings, get_settings
from app.db.migrations import initialize_database
from fastapi import FastAPI
from fastapi.testclient import TestClient

URL = "/api/player-bindings"
FIRST = {"player_id": "account.first", "player_name": "First"}
SECOND = {"player_id": "account.second", "player_name": "Second"}


@pytest.fixture
def client(database_path: Path) -> TestClient:
    initialize_database(database_path)
    app = FastAPI()
    app.include_router(router)
    settings = Settings(APP_DATABASE_PATH=database_path)
    app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


def test_import_then_switch_across_devices(client: TestClient) -> None:
    assert client.get(URL).json() == {"active": "", "players": []}
    old = {"active": FIRST["player_id"], "players": [FIRST]}
    assert client.post(f"{URL}/import", json=old).json() == old

    other = TestClient(client.app)
    saved = {"active": SECOND["player_id"], "players": [FIRST, SECOND]}
    assert other.put(f"{URL}/active", json=SECOND).json() == saved
    assert client.get(URL).json() == saved

    third = {"player_id": "account.third", "player_name": "Third"}
    another_browser = {"active": third["player_id"], "players": [FIRST, third]}
    saved["players"].append(third)
    assert client.post(f"{URL}/import", json=another_browser).json() == saved
    assert client.post(f"{URL}/import", json=another_browser).json() == saved
    assert other.put(f"{URL}/active", json=FIRST).json()["active"] == FIRST["player_id"]
    assert client.get(URL).json()["players"] == saved["players"]


def test_concurrent_bindings_retain_both_players(client: TestClient) -> None:
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda p: client.put(f"{URL}/active", json=p), [FIRST, SECOND]))
    assert all(response.status_code == 200 for response in responses)
    saved = client.get(URL).json()
    assert sorted(saved["players"], key=lambda p: p["player_id"]) == [FIRST, SECOND]
    assert saved["active"] in {FIRST["player_id"], SECOND["player_id"]}


def test_invalid_import_leaves_bindings_intact(client: TestClient) -> None:
    original = client.put(f"{URL}/active", json=FIRST).json()
    invalid = {"active": FIRST["player_id"], "players": [SECOND]}
    assert client.post(f"{URL}/import", json=invalid).status_code == 422
    assert client.get(URL).json() == original
