import httpx
import pytest
from app.api.ingest import get_database_connection, get_pubg_client
from app.core.config import Settings, get_settings
from app.main import app
from app.services.pubg_api import PubgApiClient
from app.services.pubg_cache import PubgCache
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
        client = PubgApiClient(
            api_key="test",
            transport=httpx.MockTransport(handler),
            cache=PubgCache(tmp_path / "api-cache.sqlite3", "https://api.pubg.com"),
        )
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


def test_bound_player_recent_window_and_replay_sync(setup_api):
    downloads = []
    player = {
        "id": ME["accountId"],
        "attributes": {"name": ME["name"]},
        "relationships": {"matches": {"data": [{"id": f"game-{day}"} for day in range(1, 23)]}},
    }

    def upstream(request):
        path = request.url.path
        if path == "/shards/steam/players/account.me":
            return httpx.Response(200, json={"data": player})
        if path.startswith("/shards/steam/matches/game-"):
            day = int(path.rsplit("-", 1)[1])
            return httpx.Response(
                200,
                json={
                    "data": {
                        "attributes": {
                            "createdAt": f"2026-06-{day:02}T00:00:00Z",
                            "gameMode": "duo" if day == 21 else "solo",
                            "matchType": "competitive",
                            "mapName": "Desert_Main",
                            "duration": 1500,
                        }
                    },
                    "included": [{"attributes": {"URL": f"https://telemetry.test/log/{day}"}}],
                },
            )
        if path.startswith("/log/"):
            downloads.append(path)
            events = [
                {
                    "_T": "LogGameStatePeriodic",
                    "common": {"isGame": 1},
                    "gameState": {
                        "elapsedTime": 60,
                        "poisonGasWarningPosition": {"x": 12345, "y": 23456},
                        "poisonGasWarningRadius": 10000,
                    },
                },
                *[
                    {
                        "_T": "LogPlayerPosition",
                        "elapsedTime": 60,
                        "character": {
                            **character,
                            "location": {"x": 10000, "y": 10000},
                        },
                    }
                    for character in (ME, dict(RIVAL, teamId=1))
                ],
            ]
            return httpx.Response(200, json=events)
        raise AssertionError(path)

    client = setup_api(upstream)
    manifest = client.get("/api/ingest/players/recent?query=account.me").json()
    ids = [m["match_id"] for m in manifest["matches"]]
    assert ids == [f"game-{i}" for i in range(22, 2, -1)]
    assert manifest["player_id"] == "account.me"
    for match in ("game-21", "game-22", "game-21", "game-1"):
        r = client.post(f"/api/ingest/matches/{match}/prepare?player_id=account.me")
        assert r.status_code == 200, r.text
        assert r.json()["telemetry_parse_status"] == "completed"
        assert r.json()["replay_ready"] is True
    assert downloads == ["/log/21", "/log/22", "/log/1"]
    assert client.get("/api/ingest/matches?player_id=account.stranger&limit=20").json() == {
        "matches": []
    }
    window = {"player_id": "account.me", "match_limit": 20, "match_ids": ids}
    trend = client.post("/api/ingest/players/personal-trend", json=window)
    assert [m["match_id"] for m in trend.json()["matches"]] == ["game-22", "game-21"]
    team = client.post("/api/ingest/players/team-dashboard", json=window)
    assert [m["match_id"] for m in team.json()["matches"]] == ["game-21"]
    assert [p["player_id"] for p in team.json()["teammates"]] == ["account.rival"]
    assert (
        client.post("/api/ingest/matches/game-21/prepare?player_id=account.stranger").status_code
        == 404
    )


def test_team_comparison_uses_all_selected_members_on_same_team(
    setup_api,
    migrated_connection,
    tmp_path,
):
    import json

    members = ["account.me", "account.b", "account.c"]
    db = migrated_connection
    games = {
        "shared": [(member, "1") for member in [*members, "account.fourth"]],
        "partial": [(members[0], "1"), (members[1], "1")],
        "opposing": [(members[0], "1"), (members[1], "1"), (members[2], "2")],
        "outside-window": [(member, "1") for member in members],
    }
    for match_id, roster in games.items():
        db.execute(
            """INSERT INTO matches(match_id, map_name, shard_id, game_mode, match_type)
                      VALUES (?, 'Desert_Main','steam','squad','official')""",
            (match_id,),
        )
        for team_id in {team_id for _, team_id in roster}:
            db.execute(
                "INSERT INTO match_teams(match_id,team_id) VALUES (?,?)", (match_id, team_id)
            )
        db.executemany(
            "INSERT INTO match_rosters(match_id,team_id,player_id,player_name) VALUES (?,?,?,?)",
            [(match_id, team, member, member[8:]) for member, team in roster],
        )
        db.execute(
            """INSERT INTO player_life_events(
            match_id,elapsed_time,event_type,actor_player_id,victim_player_id,damage
        ) VALUES (?,10,'LogPlayerTakeDamage','account.me','account.rival',?)""",
            (match_id, 20 if match_id == "shared" else 100),
        )
    db.executemany(
        """
        INSERT INTO player_life_events(match_id, elapsed_time, event_type,
                                      actor_player_id, victim_player_id, damage)
        VALUES ('shared', ?, ?, 'account.me', 'account.b', ?)
    """,
        [(30, "LogPlayerTakeDamage", 90), (35, "LogPlayerKillV2", None)],
    )
    local_events = [
        {"_T": "LogMatchDefinition", "MatchId": "match.bro.official.pc-2018-42.steam.abc"},
        damage(ME, RIVAL),
        {"_T": "LogMatchStart"},
        damage(ME, RIVAL),
        damage(RIVAL, ME),
        damage(dict(ME, accountId=members[1]), RIVAL),
        damage(dict(ME, accountId="account.fourth"), dict(RIVAL, accountId="account.another")),
        damage(ME, dict(ME, accountId=members[1])),
        damage(BOT, ME),
        damage(None, ME),
    ]
    (tmp_path / "shared.json").write_text(json.dumps(local_events))

    def no_network(req):
        raise AssertionError(f"local comparison unexpectedly fetched {req.url}")

    api = setup_api(no_network)
    args = {
        "player_id": members[0],
        "teammate_ids": members[1:],
        "match_ids": ["shared", "partial", "opposing"],
    }
    dashboard = api.post("/api/ingest/players/team-dashboard", json=args).json()
    assert [m["match_id"] for m in dashboard["matches"]] == ["shared"]
    assert [m["match_count"] for m in dashboard["selected_players"]] == [1, 1, 1]
    assert dashboard["selected_players"][0]["damage"] == 20
    assert dashboard["selected_players"][0]["kills"] == 0
    assert dashboard["selected_players"][1]["deaths"] == 1
    assert dashboard["matches"][0]["damage"] == 20
    sample = api.post("/api/opponents/matches/shared/team", json={"player_ids": members})
    assert sample.json() == {
        "season": SEASON,
        "game_mode": "squad",
        "match_type": "official",
        "opponents": {members[0]: ["account.rival"], members[1]: ["account.rival"], members[2]: []},
    }
    for selected in ([members[0]], members):
        full = api.post(
            "/api/opponents/matches/shared/team", json={"player_ids": selected, "full_team": True}
        )
        assert full.status_code == 200
        assert full.json()["opponents"] == {
            **sample.json()["opponents"], "account.fourth": ["account.another"],
        }
    for match_id in ("partial", "opposing"):
        response = api.post(f"/api/opponents/matches/{match_id}/team", json={"player_ids": members})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "NO_SHARED_TEAM"
    for invalid in ([members[0]], [members[0], members[0]], [*members, "account.d", "account.e"]):
        assert (
            api.post("/api/opponents/matches/shared/team", json={"player_ids": invalid}).status_code
            == 422
        )
    empty = api.post(
        "/api/ingest/players/team-dashboard", json={**args, "match_ids": ["partial", "opposing"]}
    ).json()
    assert empty["matches"] == []
    assert all(m["match_count"] == 0 for m in empty["selected_players"])


def test_archived_date_has_no_count_cap_and_uses_beijing_start_time(setup_api, migrated_connection):
    db = migrated_connection
    start = "2024-05-31T16:00:00Z"
    last = "2024-06-01T23:59:59.999999+08:00"
    entries = [(f"round-{i:03}", f"2024-06-01T01:{i // 60:02}:{i % 60:02}Z") for i in range(104)]
    entries.extend(
        [
            ("first", start),
            ("last", last),
            ("too-early", "2024-05-31T15:59:59.999999Z"),
            ("next-day", "2024-06-01T16:00:00Z"),
            ("foreign", start),
        ]
    )
    for mid, timestamp in entries:
        db.execute(
            """INSERT INTO matches(match_id, map_name, shard_id, game_mode, created_at)
                      VALUES (?, 'Desert_Main', 'steam', 'duo', ?)""",
            (mid, timestamp),
        )
        db.execute("INSERT INTO match_teams(match_id, team_id) VALUES (?, '1')", (mid,))
        players = ["other"] if mid == "foreign" else ["me", "friend"]
        db.executemany(
            """INSERT INTO match_rosters(match_id, team_id, player_id, player_name)
                        VALUES (?, '1', ?, ?)""",
            [(mid, f"account.{p}", p) for p in players],
        )

    def no_network(req):
        raise AssertionError(f"archive-only date should not contact PUBG: {req.url}")

    api = setup_api(no_network)
    params = {"player_id": "account.me", "match_date": "2024-06-01"}
    manifest = api.get(
        "/api/ingest/players/recent",
        params={"query": params["player_id"], "match_date": params["match_date"]},
    ).json()
    assert "已存档" in manifest["warnings"][0]
    opponents = api.get(
        "/api/opponents/recent", params={"name": "account.me", "match_date": params["match_date"]}
    ).json()
    local = api.get("/api/ingest/matches", params=params).json()
    personal = api.post("/api/ingest/players/personal-trend", json=params).json()
    team = api.post(
        "/api/ingest/players/team-dashboard", json={**params, "teammate_ids": ["account.friend"]}
    ).json()
    expected = ["last", *(f"round-{i:03}" for i in reversed(range(104))), "first"]
    for result in (manifest, opponents, local, personal, team):
        assert [m["match_id"] for m in result["matches"]] == expected
    assert (
        api.get(
            "/api/opponents/recent", params={"name": "account.me", "match_date": "2024-06-10"}
        ).json()["matches"]
        == []
    )
    assert personal["early"]["match_count"] + personal["recent"]["match_count"] == len(expected)
    assert team["teammates"][0]["match_count"] == len(expected)
    for endpoint in ("personal-trend", "team-dashboard"):
        assert (
            api.post(
                f"/api/ingest/players/{endpoint}", json={**params, "match_date": "2024-06-10"}
            ).json()["matches"]
            == []
        )
        assert (
            api.post(
                f"/api/ingest/players/{endpoint}", json={**params, "match_ids": ["too-early"]}
            ).status_code
            == 422
        )
    assert len(api.get("/api/ingest/matches?player_id=account.me&limit=20").json()["matches"]) == 20


@pytest.mark.parametrize(
    ("endpoint", "player_param"),
    [("/api/ingest/players/recent", "query"), ("/api/opponents/recent", "name")],
)
def test_online_day_filters_before_recent_limit_and_merges_archive(
    setup_api, migrated_connection, endpoint, player_param
):
    from datetime import UTC, datetime, timedelta

    day = datetime.now(UTC).date() - timedelta(days=2)
    following = day + timedelta(days=1)
    outside = [f"later-{i}" for i in range(23)]
    ids = [*outside, "local", "online", "prior"]
    db = migrated_connection
    for mid in ("local", "archive-extra", outside[0]):
        db.execute(
            """INSERT INTO matches(match_id, map_name, shard_id, game_mode, created_at)
                      VALUES (?, 'Desert_Main', 'steam', 'duo', ?)""",
            (mid, f"{following if mid == outside[0] else day}T04:00:00Z"),
        )
        db.execute("INSERT INTO match_teams(match_id, team_id) VALUES (?, '1')", (mid,))
        db.execute(
            """INSERT INTO match_rosters(match_id, team_id, player_id, player_name)
                    VALUES (?, '1', 'account.me','Me')""",
            (mid,),
        )

    def upstream(request):
        if request.url.path.endswith("/players/account.me"):
            return httpx.Response(
                200,
                json={
                    "data": {
                        "id": "account.me",
                        "attributes": {"name": "Me"},
                        "relationships": {"matches": {"data": [{"id": mid} for mid in ids]}},
                    }
                },
            )
        mid = request.url.path.rsplit("/", 1)[1]
        assert mid in ids and mid not in ("local", outside[0])
        when = (
            f"{following}T10:00:00Z"
            if mid in outside
            else (
                f"{day - timedelta(days=1)}T17:00:00Z"
                if mid == "online"
                else f"{day - timedelta(days=1)}T15:00:00Z"
            )
        )
        return httpx.Response(200, json={"data": {"attributes": {"createdAt": when}}})

    api = setup_api(upstream)
    result = api.get(endpoint, params={player_param: "account.me", "match_date": day.isoformat()})
    assert result.status_code == 200, result.text
    assert [m["match_id"] for m in result.json()["matches"]] == ["local", "archive-extra", "online"]


def test_repeated_opponent_analysis_reads_disk_across_client_restart(setup_api):
    calls = []

    def upstream(req):
        calls.append(req.url.path)
        path = req.url.path
        if path.endswith("/players"):
            if req.url.params.get("filter[playerNames]"):
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "id": "account.me",
                                "attributes": {"name": "Me"},
                                "relationships": {"matches": {"data": [{"id": "fight"}]}},
                            }
                        ]
                    },
                )
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "attributes": {"gameModeStats": {"squad": STATS}},
                            "relationships": {"player": {"data": {"id": "account.rival"}}},
                        }
                    ]
                },
            )
        if path.endswith("/matches/fight"):
            return httpx.Response(
                200,
                json={
                    "data": {
                        "attributes": {
                            "gameMode": "squad",
                            "matchType": "official",
                            "mapName": "Desert_Main",
                            "createdAt": "2026-07-01T00:00:00Z",
                        }
                    },
                    "included": [{"attributes": {"URL": "https://telemetry.test/events"}}],
                },
            )
        if path == "/events":
            return httpx.Response(
                200,
                json=[
                    {
                        "_T": "LogMatchDefinition",
                        "MatchId": "match.bro.official.pc-2018-42.steam.abc",
                    },
                    damage(ME, RIVAL),
                ],
            )
        if path.endswith("/survival_mastery"):
            return httpx.Response(200, json={"data": {"attributes": {"tier": 2, "level": 123}}})
        raise AssertionError(path)

    params = {"season": SEASON, "mode": "squad", "ranked": False, "player_ids": ["account.rival"]}
    api = setup_api(upstream)

    def analyze(api, ref):
        recent = api.get("/api/opponents/recent", params={"name": ref}).json()
        mid = recent["matches"][0]["match_id"]
        contacts = api.get(
            f"/api/opponents/matches/{mid}", params={"player_id": recent["player_id"]}
        ).json()
        stats = api.post("/api/opponents/stats", json=params).json()
        mastery = api.get("/api/opponents/mastery/account.rival").json()
        return contacts, stats, mastery

    cold = analyze(api, "Me")
    assert len(calls) == 5

    def offline(req):
        raise AssertionError(f"unexpected upstream call on warm run: {req.url}")

    restarted = setup_api(offline)
    assert analyze(restarted, "account.me") == cold
    snapshot = restarted.post(
        "/api/opponents/profiles/cached",
        json={**params, "player_ids": ["account.rival", "account.new"]},
    ).json()
    assert snapshot == {"stats": cold[1], "mastery": {"account.rival": cold[2]}}
