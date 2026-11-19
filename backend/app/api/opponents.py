from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query
from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.api.ingest import DatabaseDep, PubgClientDep, SettingsDep
from app.core.errors import AppError
from app.services.opponents import PLATFORM, match_encounters, recent_matches, season_stats

router = APIRouter(prefix="/api/opponents", tags=["opponents"])
AccountId = Annotated[str, StringConstraints(pattern=r"^account\.[a-zA-Z0-9_-]{1,64}$")]
MatchId = Annotated[str, Path(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]


@router.get("/recent")
def recent(
    connection: DatabaseDep,
    pubg_client: PubgClientDep,
    name: Annotated[str, Query(min_length=1, max_length=64, pattern=r"^[^,\s]+$")],
    limit: int = Query(20, ge=15, le=20),
) -> dict:
    return recent_matches(connection, pubg_client, name, limit)


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
    try:
        return season_stats(
            pubg_client, request.season, request.mode, request.ranked, request.player_ids
        )
    except AppError as exc:
        if exc.details.get("upstream_status") == 404:
            return {}
        raise


@router.get("/mastery/{player_id}")
def mastery(player_id: AccountId, pubg_client: PubgClientDep) -> dict:
    try:
        payload = pubg_client.get_survival_mastery(PLATFORM, player_id)
    except AppError as exc:
        if exc.details.get("upstream_status") == 404:
            return {"tier": None, "level": None}
        raise
    attrs = payload["data"]["attributes"]
    return {"tier": attrs.get("tier"), "level": attrs.get("level")}
