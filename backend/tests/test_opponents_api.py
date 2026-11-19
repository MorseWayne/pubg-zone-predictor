import httpx
import pytest
from app.api.ingest import get_database_connection, get_pubg_client
from app.core.config import Settings, get_settings
from app.main import app
from app.services.pubg_api import PubgApiClient
from fastapi.testclient import TestClient

SEASON = "division.bro.official.pc-2018-42"
ME = {"accountId": "account.me", "name": "Me", "teamId": 1}
RIVAL = {"accountId": "account.rival", "name": "Rival", "teamId": 2}
BOT = {"accountId": "ai.1", "name": "Bot", "teamId": 3}
STATS = {"roundsPlayed": 11, "losses": 10, "kills": 20, "damageDealt": 330}


def damage(actor, victim, amount=10):
    return {"_T": "LogPlayerTakeDamage", "attacker": actor, "victim": victim, "damage": amount}


@pytest.fixture
def setup_api(migrated_connection, tmp_path):
    def setup(handler):
        client = PubgApiClient(api_key="test", transport=httpx.MockTransport(handler))
        app.dependency_overrides[get_pubg_client] = lambda: client
        app.dependency_overrides[get_database_connection] = lambda: migrated_connection
        settings = Settings(PUBG_TELEMETRY_CACHE_DIR=tmp_path)
        app.dependency_overrides[get_settings] = lambda: settings
        return TestClient(app)

    yield setup
    for dep in (get_pubg_client, get_database_connection, get_settings):
        app.dependency_overrides.pop(dep, None)


def test_recent_through_stats_and_mastery(setup_api):
    def upstream(req):
        path = req.url.path
        if path == "/shards/steam/players":
            assert req.url.params["filter[playerNames]"] == "Me"
            refs = [{"id": i} for i in ("older", "latest", "latest")]
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "account.me",
                            "attributes": {"name": "Me"},
                            "relationships": {"matches": {"data": refs}},
                        }
                    ]
                },
            )
        if "/matches/" in path:
            day = "02" if path.endswith("latest") else "01"
            return httpx.Response(
                200,
                json={
                    "data": {
                        "attributes": {
                            "createdAt": f"2026-06-{day}T00:00:00Z",
                            "gameMode": "squad",
                            "matchType": "official",
                            "mapName": "Desert_Main",
                        }
                    },
                    "included": [{"attributes": {"URL": "https://test/log"}}],
                },
            )
        if path == "/log":
            friend = dict(RIVAL, teamId=1)
            outsider = dict(RIVAL, accountId="account.outsider")
            events = [
                {"_T": "LogMatchDefinition", "MatchId": "match.bro.official.pc-2018-42.steam.abc"},
                damage(ME, outsider),
                {"_T": "LogMatchStart"},
                damage(ME, RIVAL),
                damage(ME, RIVAL),
                damage(RIVAL, ME),
                damage(ME, BOT),
                damage(friend, ME),
                damage(ME, outsider, 0),
                damage(None, ME),
                damage(ME, ME),
                damage(outsider, BOT),
                {"_T": "LogPlayerMakeGroggy", "attacker": ME, "victim": RIVAL},
                {"_T": "LogPlayerKillV2", "killer": RIVAL, "victim": ME},
                {"_T": "LogPlayerAttack", "attacker": ME, "victim": outsider},
            ]
            return httpx.Response(200, json=events)
        if path.endswith("/gameMode/squad/players"):
            assert req.url.params["filter[playerIds]"] == "account.rival,account.other"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "relationships": {"player": {"data": {"id": "account.rival"}}},
                            "attributes": {"gameModeStats": {"squad": STATS}},
                        }
                    ]
                },
            )
        if path.endswith("/ranked"):
            ranked = dict(STATS, deaths=8, currentTier={"tier": "Gold", "subTier": "2"})
            return httpx.Response(
                200, json={"data": {"attributes": {"rankedGameModeStats": {"squad": ranked}}}}
            )
        if path.endswith("/survival_mastery"):
            return httpx.Response(200, json={"data": {"attributes": {"level": 23, "tier": 2}}})
        raise AssertionError(path)

    api = setup_api(upstream)
    history = api.get("/api/opponents/recent", params={"name": "Me", "limit": 15}).json()
    assert [m["match_id"] for m in history["matches"]] == ["latest", "older"]
    assert not history["warnings"]
    encounters = api.get(
        "/api/opponents/matches/latest", params={"player_id": history["player_id"]}
    )
    assert encounters.json() == {
        "season": SEASON,
        "opponents": [
            {
                "player_id": "account.rival",
                "name": "Rival",
                "kind": "human",
                "actions": ["out_damage", "in_damage", "out_knock", "in_kill"],
            },
            {"player_id": "ai.1", "name": "Bot", "kind": "bot", "actions": ["out_damage"]},
        ],
    }
    params = {
        "season": SEASON,
        "mode": "squad",
        "ranked": False,
        "player_ids": ["account.rival", "account.other"],
    }
    assert api.post("/api/opponents/stats", json=params).json() == {
        "account.rival": {"rounds": 11, "kd": 2, "adr": 30, "rank": None}
    }
    assert api.post("/api/opponents/stats", json=dict(params, ranked=True)).status_code == 422
    params.update(ranked=True, player_ids=["account.rival"])
    assert api.post("/api/opponents/stats", json=params).json()["account.rival"] == {
        "rounds": 11,
        "kd": 2.5,
        "adr": 30,
        "rank": "Gold 2",
    }
    assert api.get("/api/opponents/mastery/account.rival").json() == {"tier": 2, "level": 23}


def test_missing_stats_and_quota(setup_api):
    def upstream(req):
        if req.url.path.endswith("/ranked"):
            row = dict(STATS, deaths=0)
            return httpx.Response(
                200, json={"data": {"attributes": {"rankedGameModeStats": {"squad": row}}}}
            )
        if req.url.path.endswith("account.missing/survival_mastery"):
            return httpx.Response(404)
        return httpx.Response(429)

    api = setup_api(upstream)
    params = {"season": SEASON, "mode": "squad", "ranked": True, "player_ids": ["account.rival"]}
    assert api.post("/api/opponents/stats", json=params).json()["account.rival"]["kd"] is None
    params["mode"] = "solo"
    assert api.post("/api/opponents/stats", json=params).json() == {"account.rival": None}
    assert api.get("/api/opponents/mastery/account.missing").json()["level"] is None
    response = api.get("/api/opponents/mastery/account.rival")
    assert response.status_code == 429
    assert response.json()["error"]["details"]["retry_after"] > 0


def test_archived_match_kept_separate_from_live_history(setup_api, migrated_connection, tmp_path):
    db = migrated_connection
    db.execute("""
        INSERT INTO matches(match_id, map_name, shard_id, game_mode, match_type, created_at)
        VALUES('archived','Desert_Main','steam','squad','official','2026-06-01T00:00:00Z')
    """)
    db.execute("INSERT INTO match_teams(match_id, team_id) VALUES('archived','1')")
    db.execute("""
        INSERT INTO match_rosters(match_id, team_id, player_id, player_name)
        VALUES('archived','1','account.me','Me')
    """)
    (tmp_path / "archived.json").write_text('[{"_T":"LogMatchStart"}]')
    api = setup_api(lambda req: httpx.Response(404))
    history = api.get("/api/opponents/recent?name=Me&limit=15").json()
    assert history["player_id"] == "account.me"
    assert [m["match_id"] for m in history["matches"]] == ["archived"]
    assert history["warnings"]
    report = api.get("/api/opponents/matches/archived?player_id=account.me").json()
    assert report == {"season": None, "opponents": []}
