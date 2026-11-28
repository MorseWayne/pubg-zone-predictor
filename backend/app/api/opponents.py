from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query, Request
from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator

from app.api.ingest import DatabaseDep, PubgClientDep, SettingsDep
from app.services.opponents import (
    MASTERY_RESOURCE,
    match_encounters,
    season_stats,
    survival_mastery,
    team_encounters,
)
from app.services.player_history import recent_matches
from app.services.team_day_fills import batches, plan_cache, scope_key
from app.services.team_day_intensity import read_day, selection, shared_days, trend_row, warnings

router = APIRouter(prefix="/api/opponents", tags=["opponents"])
AccountId = Annotated[str, StringConstraints(pattern=r"^account\.[a-zA-Z0-9_-]{1,64}$")]
MatchId = Annotated[str, Path(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]


@router.get("/recent")
def recent(
    connection: DatabaseDep,
    pubg_client: PubgClientDep,
    name: Annotated[str, Query(min_length=1, max_length=64, pattern=r"^[^,\s]+$")],
    limit: int = Query(20, ge=15, le=20),
    match_date: date | None = None,
) -> dict:
    return recent_matches(connection, pubg_client, name, limit, match_date=match_date)


@router.get("/matches/{match_id}")
def encounters(
    match_id: MatchId,
    player_id: AccountId,
    connection: DatabaseDep,
    pubg_client: PubgClientDep,
    settings: SettingsDep,
) -> dict:
    return match_encounters(
        connection, pubg_client, settings.telemetry_cache_dir, match_id, player_id
    )


class TeamEncounterRequest(BaseModel):
    player_ids: list[AccountId] = Field(min_length=1, max_length=4)
    full_team: bool = False

    @model_validator(mode="after")
    def distinct_members(self):
        if not self.full_team and len(self.player_ids) < 2:
            raise ValueError("队员对比至少需要两名成员")
        if len(set(self.player_ids)) != len(self.player_ids):
            raise ValueError("每个成员只能选择一次")
        return self


@router.post("/matches/{match_id}/team")
def team_match_encounters(
    match_id: MatchId,
    request: TeamEncounterRequest,
    connection: DatabaseDep,
    pubg_client: PubgClientDep,
    settings: SettingsDep,
) -> dict:
    return team_encounters(
        connection,
        pubg_client,
        settings.telemetry_cache_dir,
        match_id,
        request.player_ids,
        full_team=request.full_team,
    )


class StatsRequest(BaseModel):
    season: str = Field(pattern=r"^division\.bro\.official\.pc-2018-[0-9]{1,4}$")
    mode: Literal["solo", "duo", "squad", "solo-fpp", "duo-fpp", "squad-fpp"]
    ranked: bool
    player_ids: list[AccountId] = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def ranked_single_player(self):
        if self.ranked and len(self.player_ids) != 1:
            raise ValueError("Ranked stats require exactly one player")
        return self


@router.post("/stats")
def stats(request: StatsRequest, pubg_client: PubgClientDep) -> dict:
    return season_stats(
        pubg_client, request.season, request.mode, request.ranked, request.player_ids
    )


@router.get("/mastery/{player_id}")
def mastery(player_id: AccountId, pubg_client: PubgClientDep) -> dict:
    return survival_mastery(pubg_client, player_id)


class CachedProfilesRequest(BaseModel):
    player_ids: list[AccountId] = Field(min_length=1, max_length=100)
    season: str | None = Field(
        default=None, pattern=r"^division\.bro\.official\.pc-2018-[0-9]{1,4}$"
    )
    mode: Literal["solo", "duo", "squad", "solo-fpp", "duo-fpp", "squad-fpp"] | None = None
    ranked: bool = False


@router.post("/profiles/cached")
def cached_profiles(request: CachedProfilesRequest, pubg_client: PubgClientDep) -> dict:
    ids = request.player_ids
    stats = (
        season_stats(
            pubg_client, request.season, request.mode, request.ranked, ids, cached_only=True
        )
        if request.season and request.mode
        else {}
    )
    levels = pubg_client.cache.read(MASTERY_RESOURCE, ids) if pubg_client.cache else {}
    return {
        "stats": stats,
        "mastery": {pid: row or {"tier": None, "level": None} for pid, row in levels.items()},
    }


class TeamDaysSelection(BaseModel, extra="forbid"):
    player_ids: list[AccountId] | None = Field(default=None, min_length=1, max_length=4)
    include_random_teammates: bool = False
    require_all: bool = False

    def min_members(self, players: list[str]) -> int:
        return len(players) if self.require_all else min(2, len(players))

    @model_validator(mode="after")
    def distinct_players(self):
        if self.player_ids and len(self.player_ids) != len(set(self.player_ids)):
            raise ValueError("每个成员只能选择一次")
        return self


class TeamDaysView(TeamDaysSelection):
    dates: list[date] | None = Field(default=None, min_length=1, max_length=7)
    date_a: date | None = None
    date_b: date | None = None
    trend_limit: int = Field(30, ge=1, le=366)

    @field_validator("dates")
    @classmethod
    def distinct_dates(cls, dates: list[date] | None):
        if dates is not None and len(set(dates)) != len(dates):
            raise ValueError("每个日期只能选择一次")
        return dates


class TeamDaysEnsure(TeamDaysSelection):
    dates: list[date] = Field(min_length=1, max_length=7)
    manual_continue: bool = False

    @field_validator("dates")
    @classmethod
    def normalize_dates(cls, dates: list[date]):
        unique = list(dict.fromkeys(dates))
        # A repeated single-day request was only valid in the old one/two-slot form.
        if len(unique) == 1 and len(dates) > 2:
            raise ValueError("同一天的补齐请求最多可重复两项")
        return unique


@router.post("/team-days/view")
def team_days_view(
    request: Request, body: TeamDaysView, connection: DatabaseDep, pubg_client: PubgClientDep
) -> dict:
    bindings, players, warning = selection(connection, body.player_ids)
    min_members = body.min_members(players)
    matches = shared_days(connection, players, min_members)
    dates = sorted(matches, reverse=True)
    if body.dates is None and (body.date_a or body.date_b):
        # Keep the legacy slots independent, even if A has no default and only B was given.
        a = body.date_a.isoformat() if body.date_a else next(iter(dates), None)
        b = body.date_b.isoformat() if body.date_b else next((d for d in dates if d != a), None)
        selected = [d for d in (a, b) if d is not None]
    else:
        selected = [d.isoformat() for d in body.dates] if body.dates is not None else dates[:4]
        a = selected[0] if selected else None
        b = selected[1] if len(selected) > 1 else None
    trend_dates = dates[: body.trend_limit]
    daily = {
        d: read_day(connection, players, body.include_random_teammates, d, matches[d], min_members)
        for d in dict.fromkeys([*selected, *trend_dates])
        if d in matches
    }
    days = [daily[d].payload for d in selected if d in daily]
    da, db = (daily[d].payload if d in daily else None for d in (a, b))
    backfill = request.app.state.season_backfill
    if backfill:
        backfill.trigger(
            [
                m["match_id"]
                for d in dict.fromkeys(selected)
                for m in matches.get(d, ())
                if not m["season_id"]
            ]
        )
    keys = {k for d in selected if d in daily for k in daily[d].missing}
    cached, misses = plan_cache(pubg_client, keys)
    hits = sum(x.payload["from_disk_cache"] for x in daily.values())
    return dict(
        timezone="Asia/Shanghai",
        bindings=bindings,
        selected_player_ids=players,
        require_all=body.require_all,
        min_members=min_members,
        selection_warning=warning,
        available_dates=dates,
        selected_dates=selected,
        days=days,
        date_a=a,
        date_b=b,
        day_a=da,
        day_b=db,
        trend=[trend_row(daily[d].payload) for d in reversed(trend_dates)],
        warnings=warnings(
            days,
            same_day=body.dates is None and body.date_a is not None and body.date_a == body.date_b,
        ),
        fill_hint=dict(
            api_key_configured=bool(pubg_client.api_key),
            missing_fillable_total=sum(d["profiles"]["missing_fillable_count"] for d in days),
            missing_fillable_a=da["profiles"]["missing_fillable_count"] if da else 0,
            missing_fillable_b=db["profiles"]["missing_fillable_count"] if db else 0,
            cache_promotable=len(cached),
            estimated_requests=sum(1 for _ in batches(misses)),
            active_job=request.app.state.team_day_fills.active(
                scope_key(players, selected, body.include_random_teammates, min_members)
            ),
        ),
        cache_stats=dict(hit_days=hits, computed_days=len(daily) - hits),
    )


@router.post("/team-days/ensure")
def team_days_ensure(
    request: Request, body: TeamDaysEnsure, connection: DatabaseDep, pubg_client: PubgClientDep
) -> dict:
    _, players, _ = selection(connection, body.player_ids)
    return request.app.state.team_day_fills.ensure(
        connection,
        pubg_client,
        players,
        [d.isoformat() for d in body.dates],
        body.include_random_teammates,
        body.min_members(players),
        manual=body.manual_continue,
    )


@router.get("/team-days/fills/{job_id}")
def team_days_fill(request: Request, job_id: str) -> dict:
    return request.app.state.team_day_fills.get(job_id)


@router.post("/team-days/fills/{job_id}/cancel")
def team_days_cancel(request: Request, job_id: str) -> dict:
    return request.app.state.team_day_fills.get(job_id, cancel=True)
