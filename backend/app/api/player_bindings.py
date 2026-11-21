import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.db.connection import database_connection

router = APIRouter(prefix="/api/player-bindings", tags=["player-bindings"])
SettingsDep = Annotated[Settings, Depends(get_settings)]


class BoundPlayer(BaseModel):
    player_id: str = Field(pattern=r"^account\.[\w-]+$")
    player_name: str = Field(min_length=1)


class Bindings(BaseModel):
    active: str
    players: list[BoundPlayer]


def _bindings(connection: sqlite3.Connection) -> Bindings:
    players = []
    active = ""
    for row in connection.execute("SELECT * FROM player_bindings ORDER BY rowid"):
        players.append(BoundPlayer(player_id=row["player_id"], player_name=row["player_name"]))
        if row["is_active"]:
            active = row["player_id"]
    return Bindings(active=active, players=players)


@router.get("")
def get_bindings(settings: SettingsDep) -> Bindings:
    with database_connection(settings.database_path) as connection:
        return _bindings(connection)


@router.put("/active")
def select_player(player: BoundPlayer, settings: SettingsDep) -> Bindings:
    with database_connection(settings.database_path) as connection:
        connection.execute("UPDATE player_bindings SET is_active = 0 WHERE is_active = 1")
        connection.execute(
            """INSERT INTO player_bindings (player_id, player_name, is_active) VALUES (?, ?, 1)
               ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name,
                                                    is_active = 1""",
            (player.player_id, player.player_name),
        )
        return _bindings(connection)


@router.post("/import")
def import_browser_bindings(bindings: Bindings, settings: SettingsDep) -> Bindings:
    if not any(player.player_id == bindings.active for player in bindings.players):
        raise HTTPException(422, "The active player must be included in the bindings.")
    with database_connection(settings.database_path) as connection:
        connection.executemany(
            """INSERT INTO player_bindings (player_id, player_name) VALUES (?, ?)
               ON CONFLICT(player_id) DO NOTHING""",
            [(player.player_id, player.player_name) for player in bindings.players],
        )
        connection.execute(
            """UPDATE player_bindings SET is_active = 1 WHERE player_id = ?
               AND NOT EXISTS (SELECT 1 FROM player_bindings WHERE is_active = 1)""",
            (bindings.active,),
        )
        return _bindings(connection)
