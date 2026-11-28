"""Entire integration path uses temporary SQLite databases, files and a mocked transport."""

import json
import threading
import time

import httpx
import pytest
from app.api.ingest import get_pubg_client
from app.core.config import Settings
from app.db.connection import database_connection
from app.main import create_app
from app.services import season_backfill, team_day_intensity
from app.services.pubg_api import PubgApiClient
from app.services.pubg_cache import PubgCache
from app.services.telemetry_parser import TelemetryParser
from fastapi.testclient import TestClient

BASE = "/api/opponents/team-days"
A, B, R, E, F, G = ("account." + x for x in "abrefg")
BOT, UNK = "ai.bot", "odd-id"
SEASON = "division.bro.official.pc-2018-45"
DAY = "2026-08-02"
BEFORE = "2026-08-01"
D = "LogPlayerTakeDamage"
WEEK = [f"2026-08-{n:02d}" for n in range(1, 8)]


def seed(
    db,
    mid="m1",
    created="2026-08-01T16:00:00Z",
    season=SEASON,
    mode="squad",
    kind="official",
    shard="steam",
    split=False,
):
    db.execute(
        "INSERT INTO matches(match_id,created_at,season_id,game_mode,match_type,shard_id,map_name) "
        "VALUES(?,?,?,?,?,?,?)",
        (mid, created, season, mode, kind, shard, "Map"),
    )
    db.executemany(
        "INSERT INTO match_teams(match_id,team_id,team_rank,is_unknown) VALUES(?,?,?,?)",
        [(mid, t, 1 if t == "1" else 3, t == "unknown") for t in ["1", "2", "3", "4", "unknown"]],
    )
    db.executemany(
        "INSERT INTO match_rosters(match_id,team_id,player_id,player_name) VALUES(?,?,?,?)",
        [
            (mid, t, p, p.upper())
            for t, p in [
                ("1", A),
                ("2" if split else "1", B),
                ("1", R),
                ("2", E),
                ("3", F),
                ("2", G),
                ("4", BOT),
                ("unknown", UNK),
            ]
        ],
    )
    db.execute(
        "INSERT INTO telemetry_assets(match_id,telemetry_url,parse_status,parse_profile) "
        "VALUES(?,?,?,?)",
        (mid, "https://example.test/" + mid, "completed", "full"),
    )


def events(db, mid, rows):
    db.executemany(
        "INSERT INTO player_life_events(match_id,elapsed_time,event_type,actor_player_id,"
        "victim_player_id,damage) VALUES(?,?,?,?,?,?)",
        [(mid, *r) for r in rows],
    )


def combat(db):
    events(
        db,
        "m1",
        [
            (1, D, A, E, 60),
            (2, D, B, E, 40),
            (3, D, E, A, 80),
            (4, D, E, BOT, 240),
            (5, D, F, B, 10),
            (6, D, F, BOT, 25),
            (7, D, R, G, 100),
            (8, D, A, BOT, 20),
            (9, D, B, A, 99),
            (10, D, None, A, 100),
            (11, D, A, A, 40),
            (12, "LogPlayerAttack", A, G, None),
            (13, "LogPlayerKill", E, A, None),
            (13.01, "LogPlayerKillV2", E, A, None),
            (14, "LogPlayerMakeGroggy", A, F, None),
            (15, "LogPlayerKillV2", A, F, None),
            (16, D, UNK, A, 40),
        ],
    )


def setup_snap(db, p, kd, adr, obs=100):
    db.execute(
        "INSERT INTO opponent_season_day_snapshots VALUES(?,?,?,?,?,?,?,?,?)",
        (DAY, p, SEASON, "squad", 0, obs, 10, kd, adr),
    )


@pytest.fixture
def make_app(tmp_path):
    apps = []

    def make(handler=None, *, key="", workers=False):
        settings = Settings(
            APP_DATABASE_PATH=tmp_path / "main.sqlite3",
            PUBG_TELEMETRY_CACHE_DIR=tmp_path / "telemetry",
            PUBG_API_KEY=key,
        )
        app = create_app(settings, background_enabled=workers)

        def no_network(req):
            pytest.fail(f"Unexpected network call: {req.url.path}")

        cache = PubgCache(tmp_path / "side.sqlite3", "https://example.test")
        client = PubgApiClient(
            key, cache=cache, transport=httpx.MockTransport(handler or no_network)
        )
        app.dependency_overrides[get_pubg_client] = lambda: client
        tc = TestClient(app)
        tc.__enter__()
        apps.append(tc)
        return tc, settings.database_path, cache

    yield make
    for tc in apps:
        tc.__exit__(None, None, None)


def post(tc, path, **body):
    resp = tc.post(BASE + "/" + path, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_four_dimensions_and_utc_boundary(make_app):
    tc, path, cache = make_app()
    with database_connection(path) as db:
        db.executemany("INSERT INTO player_bindings VALUES(?,?,?)", [(A, "A", 1), (B, "B", 0)])
        seed(db)
        combat(db)
        setup_snap(db, E, 0, 0)
        setup_snap(db, F, 3, None, 200)
        seed(db, "prev", "2026-08-01T15:59:59Z", season=None, kind="competitive", mode="duo-fpp")
        seed(db, "split", split=True)
        seed(db, "solo", mode="solo")
        seed(db, "nonsteam", shard="kakao")
    view = post(tc, "view")
    d = view["day_a"]
    summary = d["summary"]
    assert view["available_dates"] == [DAY, BEFORE] and [x["date"] for x in view["trend"]] == [
        BEFORE,
        DAY,
    ]
    assert (
        view["selected_player_ids"] == [A, B]
        and view["date_b"] == BEFORE
        and view["cache_stats"] == {"hit_days": 0, "computed_days": 2}
    )
    assert summary == dict(
        date=DAY,
        match_count=1,
        first_match_at="2026-08-01T16:00:00Z",
        last_match_at="2026-08-01T16:00:00Z",
        contacts_count=2,
        unique_opponents=2,
        enemy_teams=2,
        maps={"Map": 1},
        modes={"squad": 1},
        normal_matches=1,
        ranked_matches=0,
        wins=1,
        top3=1,
    )
    assert d["data_quality"] == dict(
        damage_ready_matches=1,
        missing_damage_matches=0,
        missing_season_matches=0,
        season_backfill_pending=False,
    )
    p = d["profiles"]
    assert p["known_kd"] == 2 and p["known_adr"] == 1 and p["kd_p50"] == 1.5 and p["adr_p50"] == 0
    assert (
        p["kd_p25"],
        p["kd_p75"],
        p["kd_ge_2_rate"],
        p["kd_ge_3_rate"],
        p["observed_min_at"],
        p["observed_max_at"],
    ) == (0.75, 2.25, 0.5, 0.5, 100, 200)
    assert [x["count"] for x in p["kd_bands"]] == [1, 0, 0, 1]
    assert d["pressure"] == dict(
        opponent_damage_p50=177.5,
        opponent_damage_p75=248.75,
        opponent_avg_kills=0.5,
        high_firepower_teams=1,
        high_firepower_team_total=2,
        high_firepower_team_rate=0.5,
        team_kills_vs_humans=1,
        team_deaths_to_humans=1,
        team_damage_taken_per_match=90,
        team_damage_dealt_per_match=100,
    )
    assert d["lobby"] == dict(
        total_players=8,
        human_count=6,
        bot_count=1,
        unknown_count=1,
        bot_rate=0.125,
        lobby_damage_p50=37.5,
        lobby_damage_p75=85,
    )
    assert d["team_performance"]["members"][0] == dict(
        player_id=A,
        player_name=A.upper(),
        match_count=1,
        kills=1,
        knocks=1,
        deaths=1,
        damage=80,
        avg_rank=1,
        wins=1,
        top3=1,
    )
    assert d["team_performance"]["matches"][0]["damage"] == 120
    assert d["opponents_detail"][0] == dict(
        player_id=E,
        player_name=E.upper(),
        encounters=1,
        kd=0,
        adr=0,
        match_damage_avg=320,
        match_kills_total=1,
        observed_at=100,
        profile_status="known",
    )
    assert {w["code"] for w in view["warnings"]} == {
        "MODE_MIX_DIFFERS",
        "SMALL_SAMPLE",
        "MISSING_SEASON",
    }
    assert view["day_b"]["profiles"]["kd_ge_2_rate"] is None
    assert (
        post(tc, "view", include_random_teammates=True)["day_a"]["summary"]["contacts_count"] == 3
    )
    assert not cache.path.exists()


def test_partial_squad_days_members_fills_and_disk_caches(make_app):
    tc, path, _ = make_app()
    third = "account.c"
    with database_connection(path) as db:
        db.executemany(
            "INSERT INTO player_bindings VALUES(?,?,?)", [(p, p, p == A) for p in (A, B, third)]
        )
        seed(db)
        combat(db)
        seed(db, "full", "2026-08-01T15:59:00Z")
        db.execute(
            "INSERT INTO match_rosters(match_id,team_id,player_id) VALUES('full','1',?)", (third,)
        )

    view = post(tc, "view")
    assert (view["require_all"], view["min_members"], view["available_dates"]) == (
        False,
        2,
        [DAY, BEFORE],
    )
    duo = view["day_a"]
    performance = duo["team_performance"]
    assert [(p["player_id"], p["match_count"]) for p in performance["members"]] == [(A, 1), (B, 1)]
    assert [p["player_id"] for p in performance["matches"][0]["players"]] == [A, B]
    assert {p["player_id"] for p in duo["opponents_detail"]} == {E, F}
    assert [p["player_id"] for p in view["day_b"]["team_performance"]["members"]] == [A, B, third]

    full = post(tc, "view", require_all=True)
    assert (full["require_all"], full["min_members"], full["available_dates"]) == (
        True,
        3,
        [BEFORE],
    )
    assert full["cache_stats"] == {"computed_days": 1, "hit_days": 0}
    assert post(tc, "view")["cache_stats"] == {"computed_days": 0, "hit_days": 2}
    assert post(tc, "view", require_all=True)["cache_stats"] == {"computed_days": 0, "hit_days": 1}
    assert post(tc, "ensure", dates=[DAY], require_all=True)["remaining"] == 0
    assert post(tc, "ensure", dates=[DAY])["remaining"] == 2


def test_split_squad_uses_only_primary_team_once(make_app):
    tc, path, _ = make_app()
    with database_connection(path) as db:
        seed(db)
        combat(db)
        # G plays on the other qualifying team. Its duel with F is not our team's contact.
        events(db, "m1", [(20, D, F, G, 51), (21, "LogPlayerKill", G, F, None)])
    day = post(tc, "view", player_ids=[G, E, B, A])["day_a"]
    assert day["summary"]["match_count"] == 1
    (match,) = day["team_performance"]["matches"]
    assert [p["player_id"] for p in match["players"]] == [A, B]
    assert (match["team_rank"], match["kills"], match["damage"]) == (1, 1, 120)
    assert {p["player_id"] for p in day["opponents_detail"]} == {E, F}
    pressure = day["pressure"]
    assert (pressure["team_kills_vs_humans"], pressure["team_deaths_to_humans"]) == (1, 1)
    assert (pressure["team_damage_dealt_per_match"], pressure["team_damage_taken_per_match"]) == (
        100,
        90,
    )


def test_incremental_persistence_and_no_warm_event_reads(make_app, monkeypatch):
    tc, path, _ = make_app()
    with database_connection(path) as db:
        seed(db)
        combat(db)
        seed(db, "past", "2026-08-01T15:59:00Z")

    def view():
        return post(tc, "view", player_ids=[A, B])

    view()
    with database_connection(path) as db:
        past = db.execute(
            "SELECT updated_at FROM team_day_intensity_summaries WHERE match_day=?", (BEFORE,)
        ).fetchone()[0]
        # Fail for *any* read of the event table, including a fingerprint COUNT query.
        import sqlite3

        db.set_authorizer(
            lambda op, table, *_: (
                sqlite3.SQLITE_DENY
                if op == sqlite3.SQLITE_READ and table == "player_life_events"
                else sqlite3.SQLITE_OK
            )
        )
        groups = team_day_intensity.shared_days(db, [B, A], min_members=2)
        assert team_day_intensity.read_day(
            db, [B, A], False, DAY, groups[DAY], min_members=2
        ).payload["from_disk_cache"]
    assert view()["cache_stats"] == {"hit_days": 2, "computed_days": 0}
    with database_connection(path) as db:
        setup_snap(db, G, 2, 100)
    assert view()["cache_stats"]["hit_days"] == 2  # irrelevant same-day snapshot
    with database_connection(path) as db:
        setup_snap(db, E, 0, 0)
    assert view()["cache_stats"] == {"hit_days": 1, "computed_days": 1}
    with database_connection(path) as db:
        seed(db, "later", "2026-08-02T02:00:00Z")
        events(db, "later", [(1, D, A, E, 1)])
    v = view()
    assert (
        v["day_a"]["summary"]["contacts_count"] == 3
        and v["day_a"]["summary"]["unique_opponents"] == 2
    )
    assert v["day_a"]["profiles"]["known_kd"] == 2 and v["cache_stats"]["computed_days"] == 1
    with database_connection(path) as db:
        db.execute("UPDATE player_life_events SET damage=55 WHERE match_id='later'")
        assert (
            db.execute(
                "SELECT updated_at FROM team_day_intensity_summaries WHERE match_day=?", (BEFORE,)
            ).fetchone()[0]
            == past
        )
    assert view()["day_a"]["pressure"]["team_damage_dealt_per_match"] == 77.5


def test_empty_and_selection_validation(make_app):
    tc, path, _ = make_app()
    v = post(tc, "view")
    assert v["selection_warning"] and not v["trend"] and v["day_a"] is None
    with database_connection(path) as db:
        db.executemany(
            "INSERT INTO player_bindings VALUES(?,?,?)", [(p, p, p == A) for p in [A, B, E, F, G]]
        )
        seed(db)
        events(db, "m1", [(1, "LogPlayerKill", A, E, None), (2, D, E, A, None)])
    v = post(tc, "view")
    assert v["selected_player_ids"] == [A] and v["date_b"] is None and v["selection_warning"]
    assert v["min_members"] == 1
    assert v["day_a"]["data_quality"]["missing_damage_matches"] == 1
    assert v["day_a"]["pressure"]["opponent_damage_p50"] is None
    v = post(tc, "view", date_a=DAY, date_b=DAY)
    assert "SAME_DAY" in {w["code"] for w in v["warnings"]}
    assert tc.post(BASE + "/view", json={"player_ids": [A, A]}).status_code == 422
    assert tc.post(BASE + "/ensure", json={"dates": [DAY] * 3}).status_code == 422
    assert tc.post(BASE + "/ensure", json={"dates": [DAY], "opponents": [G]}).status_code == 422
    assert tc.get(BASE + "/fills/absent").status_code == 404


@pytest.mark.parametrize("count", [0, 2, 6])
def test_default_selects_recent_four_days(make_app, count):
    tc, path, _ = make_app()
    dates = WEEK[:count]
    with database_connection(path) as db:
        for day in dates:
            seed(db, day, day + "T00:00:00Z")
    view = post(tc, "view", player_ids=[A, B], trend_limit=1)
    expected = dates[::-1][:4]
    assert view["selected_dates"] == expected
    assert [d["summary"]["date"] for d in view["days"]] == expected
    assert view["cache_stats"] == {"computed_days": len(expected), "hit_days": 0}


def test_multiday_order_disk_cache_fill_and_warnings(make_app, monkeypatch):
    tc, path, cache = make_app(workers=True)
    prioritized = []
    monkeypatch.setattr(tc.app.state.season_backfill, "trigger", prioritized.extend)
    with database_connection(path) as db:
        for i, day in enumerate(WEEK):
            seed(
                db,
                day,
                day + "T00:00:00Z",
                season=None if i in (3, 6) else SEASON,
                kind="competitive" if i == 4 else "official",
            )
            events(db, day, [(1, D, A, E, 10)])
        db.execute("UPDATE matches SET map_name='Other' WHERE match_id=?", (WEEK[4],))
    cache.write(f"steam/season/{SEASON}/squad", {E: {"squad": {"rounds": 5, "kd": 2}}}, 100)
    missing_day = "2026-08-20"
    selected = [WEEK[2], missing_day, WEEK[1], WEEK[0], WEEK[3], WEEK[4]]
    body = dict(player_ids=[A, B], dates=selected, date_a=DAY, date_b=DAY, trend_limit=1)
    v = post(tc, "view", **body)
    assert v["selected_dates"] == selected
    assert (v["date_a"], v["date_b"], v["day_a"], v["day_b"]) == (
        WEEK[2],
        missing_day,
        v["days"][0],
        None,
    )
    assert [d["summary"]["date"] for d in v["days"]] == [d for d in selected if d != missing_day]
    assert (
        v["fill_hint"]["missing_fillable_total"],
        v["fill_hint"]["missing_fillable_a"],
        v["fill_hint"]["missing_fillable_b"],
    ) == (4, 1, 0)
    assert (v["fill_hint"]["cache_promotable"], v["fill_hint"]["estimated_requests"]) == (3, 1)
    assert prioritized == [WEEK[3]]  # Excludes the unselected missing-season date in the trend.
    assert {w["code"] for w in v["warnings"]} == {
        "NO_MAP_OVERLAP",
        "MODE_MIX_DIFFERS",
        "SMALL_SAMPLE",
        "LOW_COVERAGE",
        "MISSING_SEASON",
    }
    assert v["cache_stats"] == {"hit_days": 0, "computed_days": 6}
    warm = post(tc, "view", **body)
    assert warm["cache_stats"] == {"hit_days": 6, "computed_days": 0}
    assert all(d["from_disk_cache"] for d in warm["days"])


def test_multiday_limits_and_legacy_slots(make_app):
    tc, path, _ = make_app()
    b_only = post(tc, "view", player_ids=[A], date_b=DAY)
    assert (b_only["date_a"], b_only["date_b"], b_only["selected_dates"]) == (None, DAY, [DAY])
    with database_connection(path) as db:
        seed(db)
    implicit_same = post(tc, "view", player_ids=[A], date_b=DAY)
    assert implicit_same["date_a"] == implicit_same["date_b"] == DAY
    assert "SAME_DAY" not in {w["code"] for w in implicit_same["warnings"]}
    assert tc.post(BASE + "/view", json={"dates": [DAY, DAY]}).status_code == 422
    for endpoint in ("view", "ensure"):
        for invalid in ([], WEEK + ["2026-08-08"]):
            assert tc.post(f"{BASE}/{endpoint}", json={"dates": invalid}).status_code == 422
    for size in range(4, 8):
        assert post(tc, "ensure", dates=WEEK[:size])["state"] == "completed"
    assert post(tc, "ensure", dates=[DAY, BEFORE, DAY, BEFORE])["state"] == "completed"


def test_parser_and_lazily_triggered_local_backfill(make_app, tmp_path, monkeypatch):
    read = []
    original = season_backfill.read_season

    def observe(path, stop):
        read.append(path.name)
        return original(path, stop)

    monkeypatch.setattr(season_backfill, "read_season", observe)
    tc, path, _ = make_app(workers=True)
    telemetry = tmp_path / "telemetry"
    telemetry.mkdir()
    definition = {
        "_T": "LogMatchDefinition",
        "MatchId": "match.bro.competitive.pc-2018-45.steam.abc",
    }
    (telemetry / "m1.json").write_text(json.dumps([{"padding": "x" * 75000}, definition]))
    (telemetry / "broken.json").write_text("not json")
    with database_connection(path) as db:
        seed(db, season=None)
        seed(db, "broken", "2026-07-01", season=None)
        seed(db, "missing", "2026-07-02", season=None)
        seed(db, "parsed", "2025-01-01", season=None)
        TelemetryParser(db).parse_match("parsed", [definition])
        assert (
            db.execute("SELECT season_id FROM matches WHERE match_id='parsed'").fetchone()[0]
            == SEASON
        )
    worker = tc.app.state.season_backfill
    assert worker.thread is None and not read
    post(tc, "view", player_ids=[A, B], date_a=DAY, date_b=DAY)
    if t := worker.thread:
        t.join(3)
    assert read == ["m1.json", "broken.json"]
    with database_connection(path) as db:
        assert (
            db.execute("SELECT season_id FROM matches WHERE match_id='m1'").fetchone()[0] == SEASON
        )
        assert (
            dict(db.execute("SELECT match_id,file_fingerprint FROM match_season_backfill_checks"))[
                "missing"
            ]
            == "missing"
        )
    worker.trigger(["broken"])
    t = worker.thread
    if t:
        t.join(3)
    assert read == ["m1.json", "broken.json"]
    (telemetry / "broken.json").write_text(json.dumps([definition]))
    worker.trigger(["broken"])
    t = worker.thread
    if t:
        t.join(3)
    assert read[-1] == "broken.json" and len(read) == 3
    d = post(tc, "view", player_ids=[A, B], date_a=DAY, date_b=DAY)["day_a"]
    assert not d["from_disk_cache"] and not d["data_quality"]["missing_season_matches"]


def test_side_cache_promotion_preserves_original_timestamp_without_key(make_app):
    tc, path, cache = make_app()
    cache.clock = lambda: 1000
    with database_connection(path) as db:
        seed(db)
        combat(db)
    resource = f"steam/season/{SEASON}/squad"
    assert cache.read_stamped(resource, [A]) == {} and not cache.path.exists()
    cache.write(resource, {E: {"squad": {"rounds": 5, "kd": 0, "adr": 0}}, F: None}, 100)
    assert cache.read_stamped(resource, [F])[F] == (None, 1000, True)
    cache.clock = lambda: 1010
    assert post(tc, "view", player_ids=[A, B])["fill_hint"]["cache_promotable"] == 1
    result = post(tc, "ensure", player_ids=[A, B], dates=[DAY])
    assert result["state"] == "no_api_key" and result["promoted"] == 1
    cache.write(resource, {E: {"squad": {"rounds": 10, "kd": 9, "adr": 100}}}, 100)
    post(tc, "ensure", player_ids=[A, B], dates=[DAY])
    day = post(tc, "view", player_ids=[A, B])["day_a"]
    assert (
        day["from_disk_cache"]
        and day["profiles"]["kd_p50"] == 0
        and day["profiles"]["observed_max_at"] == 1000
    )
    cache.clock = lambda: 10000
    assert cache.read_stamped(resource, [E, F]) == {}


def seed_many(db, n, ranked=False):
    seed(db, kind="competitive" if ranked else "official")
    ids = [f"account.rival-{i:03d}" for i in range(n)]
    db.executemany(
        "INSERT INTO match_rosters(match_id,team_id,player_id) VALUES('m1','2',?)",
        [(p,) for p in ids],
    )
    events(db, "m1", [(i, D, A, p, 10) for i, p in enumerate(ids)])


def stats_response(req):
    stats = dict(roundsPlayed=5, losses=2, deaths=2, kills=0, damageDealt=0)
    if req.url.path.endswith("/ranked"):
        return httpx.Response(
            200, json={"data": {"attributes": {"rankedGameModeStats": {"squad": stats}}}}
        )
    ids = req.url.params["filter[playerIds]"].split(",")
    return httpx.Response(
        200,
        json={
            "data": [
                {
                    "relationships": {"player": {"data": {"id": p}}},
                    "attributes": {"gameModeStats": {"squad": stats}},
                }
                for p in ids
            ]
        },
    )


def wait_done(tc, jid):
    tc.app.state.team_day_fills.thread.join(5)
    job = tc.get(BASE + "/fills/" + jid).json()
    assert job["state"] not in {"running", "queued", "paused"}, job
    return job


def test_silent_batches_freeze_before_next_call_and_refresh(make_app):
    calls = []

    def handler(req):
        ids = req.url.params["filter[playerIds]"].split(",")
        calls.append(ids)
        if len(calls) == 2:
            with database_connection(path) as db:
                assert (
                    db.execute("SELECT count(*) FROM opponent_season_day_snapshots").fetchone()[0]
                    == 10
                )
                assert (
                    json.loads(
                        db.execute(
                            "SELECT payload_json FROM team_day_intensity_summaries"
                        ).fetchone()[0]
                    )["profiles"]["known_kd"]
                    == 10
                )
        return stats_response(req)

    tc, path, _ = make_app(handler, key="test", workers=True)
    with database_connection(path) as db:
        seed_many(db, 21)
    job = wait_done(tc, post(tc, "ensure", player_ids=[A], dates=[DAY])["job_id"])
    assert (
        [len(ids) for ids in calls] == [10, 10, 1]
        and job["revision"] == 3
        and job["remaining"] == 0
        and job["requests_used"] == 3
    )
    assert post(tc, "view", player_ids=[A])["day_a"]["from_disk_cache"]
    with database_connection(path) as db:
        assert db.execute("SELECT count(*) FROM opponent_mastery_day_snapshots").fetchone()[0] == 0


def test_budget_ranked_manual_continue(make_app):
    calls = []

    def handler(req):
        calls.append(req.url.path)
        assert req.url.path.endswith("/ranked")
        return stats_response(req)

    tc, path, _ = make_app(handler, key="test", workers=True)
    with database_connection(path) as db:
        seed_many(db, 27, ranked=True)
    body = {"player_ids": [A], "dates": [DAY]}
    assert post(tc, "view", player_ids=[A])["fill_hint"]["estimated_requests"] == 27
    job = wait_done(tc, post(tc, "ensure", **body)["job_id"])
    assert (
        job["state"] == "budget_exhausted" and job["requests_used"] == 25 and job["remaining"] == 2
    )
    assert post(tc, "ensure", **body)["job_id"] == job["job_id"] and len(calls) == 25
    next_job = wait_done(tc, post(tc, "ensure", manual_continue=True, **body)["job_id"])
    assert next_job["requests_used"] == 2 and next_job["state"] == "completed"


def test_multiday_budget_prioritizes_recent_days_across_resources(make_app):
    tc, path, cache = make_app(stats_response, key="test", workers=True)
    with database_connection(path) as db:
        for i, day in enumerate(WEEK):
            # The newest and oldest day share a resource: sorting groups alone would starve day 2.
            season = SEASON if i in (0, 6) else "division.bro.official.pc-2018-46"
            seed(db, day, day + "T00:00:00Z", season=season, kind="competitive")
            ids = [f"account.rival-{i}-{n}" for n in range(4)]
            db.executemany(
                "INSERT INTO match_rosters(match_id,team_id,player_id) VALUES(?,'2',?)",
                [(day, p) for p in ids],
            )
            events(db, day, [(1, D, A, p, 10) for p in ids])
    body = dict(player_ids=[A], dates=WEEK)
    with cache.fill_lock:
        jid = post(tc, "ensure", **body)["job_id"]
        assert post(tc, "view", **body)["fill_hint"]["active_job"]["job_id"] == jid
        assert post(tc, "view", player_ids=[A], dates=WEEK[:-1])["fill_hint"]["active_job"] is None
    job = wait_done(tc, jid)
    assert (job["state"], job["requests_used"], job["remaining"]) == ("budget_exhausted", 25, 3)
    with database_connection(path) as db:
        filled = dict(
            db.execute(
                "SELECT match_day, COUNT(*) FROM opponent_season_day_snapshots GROUP BY match_day"
            )
        )
    assert filled == {day: 1 if day == WEEK[0] else 4 for day in WEEK}


def test_cancel_while_waiting_for_foreground_quota_lock(make_app):
    tc, path, cache = make_app(key="test", workers=True)
    with database_connection(path) as db:
        seed_many(db, 1)
    with cache.fill_lock:
        players = [A, B, R]
        jid = post(tc, "ensure", player_ids=players, dates=[DAY])["job_id"]
        assert post(tc, "view", player_ids=players)["fill_hint"]["active_job"]["job_id"] == jid
        assert (
            post(tc, "view", player_ids=players, require_all=True)["fill_hint"]["active_job"]
            is None
        )
        assert (
            post(tc, "ensure", player_ids=players, dates=[DAY], require_all=True)["state"] == "busy"
        )
        tc.post(f"{BASE}/fills/{jid}/cancel")
        job = wait_done(tc, jid)
        assert (job["state"], job["requests_used"]) == ("cancelled", 0)


def test_same_opponent_two_days_one_ranked_call_for_all_modes(make_app):
    calls = []

    def handler(req):
        calls.append(req.url.path)
        modes = {
            mode: dict(roundsPlayed=2, deaths=0, kills=1, damageDealt=0)
            for mode in ("squad", "duo")
        }
        return httpx.Response(200, json={"data": {"attributes": {"rankedGameModeStats": modes}}})

    tc, path, _ = make_app(handler, key="test", workers=True)
    with database_connection(path) as db:
        seed(db, kind="competitive")
        seed(db, "before", "2026-08-01T10:00:00Z", mode="duo", kind="competitive")
        for mid in ("m1", "before"):
            events(db, mid, [(1, D, A, E, 10)])
    body = dict(player_ids=[A], dates=[DAY, BEFORE])
    job = wait_done(tc, post(tc, "ensure", **body)["job_id"])
    assert job["remaining"] == 0 and job["promoted"] == 2 and len(calls) == 1
    view = post(tc, "view", player_ids=[A])
    assert view["cache_stats"]["hit_days"] == 2
    assert view["day_b"]["profiles"]["kd_p50"] is None and view["day_b"]["profiles"]["adr_p50"] == 0


@pytest.mark.parametrize("status", [401, 403, 429])
def test_rate_limit_cancel_and_auth_breaker(make_app, status):
    calls = []

    def handler(req):
        calls.append(req.url.path)
        return httpx.Response(status, headers={"Retry-After": "100"})

    tc, path, _ = make_app(handler, key="test", workers=True)
    with database_connection(path) as db:
        seed_many(db, 1)
    body = {"player_ids": [A], "dates": [DAY]}
    jid = post(tc, "ensure", **body)["job_id"]
    if status == 429:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            info = tc.get(f"{BASE}/fills/{jid}").json()
            if info["state"] == "paused":
                break
            threading.Event().wait(0.01)
        assert info["retry_after"] > 0 and post(tc, "ensure", **body)["job_id"] == jid
        assert post(tc, "view", player_ids=[A])["fill_hint"]["active_job"]["job_id"] == jid
        tc.post(f"{BASE}/fills/{jid}/cancel")
        assert wait_done(tc, jid)["state"] == "cancelled"
    else:
        assert (
            wait_done(tc, jid)["state"] == "auth_error"
            and post(tc, "ensure", manual_continue=True, **body)["state"] == "auth_error"
        )
    assert len(calls) == 1
