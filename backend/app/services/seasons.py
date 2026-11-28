"""Extract the stable PUBG season identifier only from definition events."""

import re

_SEASON = re.compile(r"^match\.bro\.(?:official|competitive|ranked)\.(pc-2018-\d+)\.")


def definition_season(event: object) -> str | None:
    if not isinstance(event, dict) or event.get("_T") != "LogMatchDefinition":
        return None
    value = event.get("MatchId")
    match = _SEASON.match(value) if isinstance(value, str) else None
    return f"division.bro.official.{match[1]}" if match else None
