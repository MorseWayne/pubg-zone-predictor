from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query
from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.api.ingest import DatabaseDep, PubgClientDep, SettingsDep
from app.services.opponents import (
    MASTERY_RESOURCE,
    match_encounters,
    season_stats,
    survival_mastery,
    team_encounters,
)
from app.services.player_history import recent_matches

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
    player_ids: list[AccountId] = Field(min_length=2, max_length=4)

    @model_validator(mode="after")
    def distinct_members(self):
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
        connection, pubg_client, settings.telemetry_cache_dir, match_id, request.player_ids
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
