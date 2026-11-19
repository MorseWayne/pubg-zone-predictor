import json
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from app.core.errors import AppError
from app.services import opponents
from app.services.opponents import match_encounters, season_stats, survival_mastery, team_encounters
from app.services.player_history import remote_match
from app.services.pubg_api import PubgApiClient
from app.services.pubg_cache import ABSENT_TTL, MASTERY_TTL, PLAYER_TTL, SEASON_TTL, PubgCache

ORIGIN = "https://pubg.test"
SEASON = "division.bro.official.pc-2018-42"
A, B, C = ("account.a", "account.b", "account.c")
MODE = {"roundsPlayed": 4, "kills": 6, "losses": 2, "deaths": 3, "damageDealt": 100}


def cached_client(path, handler, clock):
    return PubgApiClient(
        api_key="test-key",
        base_url=ORIGIN,
        transport=httpx.MockTransport(handler),
        cache=PubgCache(path, ORIGIN, lambda: clock[0]),
    )


def test_player_aliases_cache_and_explicit_refresh(tmp_path):
    calls = []
    now = [1000.0]
    refs = []

    def handler(req):
        calls.append(req.url.path)
        player = {
            "id": A,
            "attributes": {"name": "Me"},
            "relationships": {"matches": {"data": refs}},
        }
        return httpx.Response(200, json={"data": player if req.url.path.endswith(A) else [player]})

    path = tmp_path / "cache.sqlite3"
    client = cached_client(path, handler, now)
    client.get_players_by_names("steam", ["Me"])
    client = cached_client(path, handler, now)
    client.get_players_by_names("steam", ["me"])
    assert client.get_player_by_id("steam", A)["data"]["relationships"]["matches"]["data"] == []
    assert len(calls) == 1
    refs.append({"id": "new"})
    client.get_player_by_id("steam", A, refresh=True)
    assert (
        client.get_players_by_names("steam", ["ME"])["data"][0]["relationships"]["matches"]["data"]
        == refs
    )
    now[0] += PLAYER_TTL + 1
    client.get_player_by_id("steam", A)
    assert len(calls) == 3


def test_overlapping_batches_modes_negative_entries_and_restart(tmp_path):
    batches, ranked = [], []
    now = [1000.0]

    def handler(req):
        if req.url.path.endswith("/ranked"):
            ranked.append(req.url.path)
            return httpx.Response(
                200,
                json={
                    "data": {"attributes": {"rankedGameModeStats": {"duo": MODE, "squad": MODE}}}
                },
            )
        ids = req.url.params["filter[playerIds]"].split(",")
        mode = req.url.path.split("/")[-2]
        batches.append((mode, ids))
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "attributes": {"gameModeStats": {mode: MODE}},
                        "relationships": {"player": {"data": {"id": pid}}},
                    }
                    for pid in ids
                    if pid != C
                ]
            },
        )

    path = tmp_path / "cache.sqlite3"
    client = cached_client(path, handler, now)

    def stats(ids, mode="squad", competitive=False):
        return season_stats(client, SEASON, mode, competitive, ids)

    assert stats([A])[A]["kd"] == 3
    client = cached_client(path, handler, now)
    assert set(stats([B, A, C])) == {A, B}
    assert set(stats([C, B])) == {B}
    assert stats([A], "duo")[A]["kd"] == 3
    assert stats([A], competitive=True)[A]["kd"] == 2
    assert stats([A], "duo", True)[A]["kd"] == 2
    assert batches == [("squad", [A]), ("squad", [B, C]), ("duo", [A])]
    assert len(ranked) == 1
    assert season_stats(client, SEASON, "squad", False, [C], cached_only=True) == {C: None}
    now[0] += ABSENT_TTL + 1
    stats([B, C])
    assert batches[-1] == ("squad", [C])
    now[0] += SEASON_TTL
    stats([A, B])
    assert batches[-1] == ("squad", [A, B])


def test_cached_hits_work_during_persistent_quota_cooldown(tmp_path):
    calls = Counter()
    now = [1000.0]

    def handler(req):
        key = req.url.path
        calls[key] += 1
        if "/matches/" in key:
            return httpx.Response(
                200,
                json={
                    "data": {"attributes": {"createdAt": "2026-07-01"}},
                    "included": [{"attributes": {"URL": "https://telemetry.test/test"}}],
                },
            )
        if key.endswith(f"{B}/survival_mastery") and calls[key] == 1:
            return httpx.Response(429, headers={"Retry-After": "30"})
        return httpx.Response(
            200,
            headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1060"},
            json={"data": {"attributes": {"tier": 1, "level": 0}}},
        )

    path = tmp_path / "cache.sqlite3"
    client = cached_client(path, handler, now)
    assert survival_mastery(client, A) == {"tier": 1, "level": 0}
    client = cached_client(path, handler, now)
    assert survival_mastery(client, A)["level"] == 0
    with pytest.raises(AppError) as err:
        survival_mastery(client, B)
    assert err.value.status_code == 429 and err.value.details["retry_after"] == 61
    assert sum(calls.values()) == 1
    remote_match(client, "match")
    remote_match(cached_client(path, handler, now), "match")
    assert sum(calls.values()) == 2
    now[0] += 61
    with pytest.raises(AppError) as err:
        survival_mastery(client, B)
    assert err.value.details["retry_after"] == 30
    with pytest.raises(AppError):
        client.get_tournaments()
    assert sum(calls.values()) == 3
    now[0] += 31
    assert survival_mastery(client, B)["level"] == 0
    now[0] += MASTERY_TTL + 1
    assert survival_mastery(client, A)["level"] == 0
    assert sum(calls.values()) == 5


def test_concurrent_misses_coalesce_and_transient_failures_retry(tmp_path):
    calls = 0

    def handler(req):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503)
        time.sleep(0.02)
        return httpx.Response(200, json={"data": {"attributes": {"tier": 3, "level": 100}}})

    client = cached_client(tmp_path / "cache.sqlite3", handler, [1000.0])
    with pytest.raises(AppError):
        survival_mastery(client, A)
    barrier = threading.Barrier(4)

    def worker(_):
        barrier.wait()
        return survival_mastery(client, A)

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(worker, range(4))) == [{"tier": 3, "level": 100}] * 4
    assert calls == 2


def test_encounters_reuse_telemetry_and_invalidate_after_file_replacement(
    tmp_path,
    migrated_connection,
    monkeypatch,
):
    db = migrated_connection
    db.execute(
        "INSERT INTO matches(match_id,map_name,shard_id,game_mode,telemetry_url) VALUES('m','map','steam','duo','https://telemetry.test/m')"
    )
    db.execute("INSERT INTO match_teams(match_id,team_id) VALUES('m','1')")
    db.executemany(
        "INSERT INTO match_rosters(match_id,team_id,player_id) VALUES('m','1',?)", [(A,), (B,)]
    )
    events = [
        {
            "_T": "LogPlayerTakeDamage",
            "damage": 2,
            "attacker": {"accountId": A, "teamId": 1},
            "victim": {"accountId": C, "teamId": 2},
        }
    ]
    requests = 0

    def handler(req):
        nonlocal requests
        requests += 1
        return httpx.Response(200, json=events)

    parsed = []
    original = opponents._member_encounters

    def observe(events, ids):
        parsed.append(ids)
        return original(events, ids)

    monkeypatch.setattr(opponents, "_member_encounters", observe)
    path = tmp_path / "cache.sqlite3"
    client = cached_client(path, handler, [1000.0])
    assert match_encounters(db, client, tmp_path, "m", A)["opponents"][0]["player_id"] == C
    client = cached_client(path, handler, [1000.0])
    assert team_encounters(db, client, tmp_path, "m", [A, B])["opponents"] == {A: [C], B: []}
    match_encounters(db, client, tmp_path, "m", B)
    assert parsed == [[A], [B]] and requests == 1
    new = tmp_path / "new.json"
    new.write_text(json.dumps([{"_T": "LogMatchStart"}]))
    new.replace(tmp_path / "m.json")
    assert match_encounters(db, client, tmp_path, "m", A)["opponents"] == []
    assert parsed == [[A], [B], [A]] and requests == 1


def test_batch_error_does_not_poison_individual_entries(tmp_path):
    calls = []

    def handler(req):
        ids = req.url.params["filter[playerIds]"].split(",")
        calls.append(ids)
        if len(ids) > 1:
            return httpx.Response(404)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "relationships": {"player": {"data": {"id": ids[0]}}},
                        "attributes": {"gameModeStats": {"squad": MODE}},
                    }
                ]
            },
        )

    client = cached_client(tmp_path / "cache.sqlite3", handler, [1000.0])
    assert season_stats(client, SEASON, "squad", False, [A, B]) == {}
    assert season_stats(client, SEASON, "squad", False, [A])[A]["kd"] == 3
    assert calls == [[A, B], [A]]
