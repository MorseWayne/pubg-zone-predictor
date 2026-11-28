"""Local, Beijing-day team analysis. Snapshots are weighted by encounters, not by accounts."""

import hashlib
import json
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from math import ceil, floor
from sqlite3 import Connection
from statistics import mean

from app.services.opponents import KILL_TYPES
from app.services.player_history import _start_time

VERSION = 2
# Key order is identical to the snapshot table's primary key.
ProfileKey = tuple[str, str, str, str, int]
DAMAGE = "LogPlayerTakeDamage"
KNOCK = "LogPlayerMakeGroggy"


def digest(values) -> str:
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


def percentile(values, fraction):
    if not values:
        return None
    seq = sorted(values)
    pos = (len(seq) - 1) * fraction
    return round(seq[floor(pos)] + (seq[ceil(pos)] - seq[floor(pos)]) * (pos % 1), 4)


def ratio(n, d):
    return round(n / d, 4) if d else None


def selection(db: Connection, player_ids):
    bindings = [
        dict(row)
        for row in db.execute("SELECT * FROM player_bindings ORDER BY is_active DESC, player_id")
    ]
    for row in bindings:
        row["is_active"] = bool(row["is_active"])
    if player_ids is not None:
        return bindings, player_ids, None
    if len(bindings) > 4:
        return (
            bindings,
            [r["player_id"] for r in bindings if r["is_active"]],
            "绑定超过四人，请确认本次分析阵容。",
        )
    return (
        bindings,
        [r["player_id"] for r in bindings],
        None if bindings else "请先绑定或选择队员。",
    )


def shared_days(db: Connection, players, min_members: int) -> dict:
    if not players:
        return {}
    rows = db.execute(
        """WITH shared AS (
        SELECT match_id, team_id, t.team_rank,
          ROW_NUMBER() OVER (PARTITION BY match_id
            ORDER BY COUNT(DISTINCT player_id) DESC, team_id ASC) AS team_choice
        FROM match_rosters JOIN match_teams t USING(match_id,team_id)
        WHERE player_id IN (SELECT value FROM json_each(?)) AND team_id NOT IN ('unknown','')
          AND t.is_unknown=0
        GROUP BY match_id,team_id HAVING COUNT(DISTINCT player_id) >= ?)
        SELECT m.match_id,m.created_at,m.map_name,m.game_mode,m.match_type,m.season_id,
          s.team_id,s.team_rank,a.parse_status,a.parse_profile,a.parsed_at,a.replay_schema_version,
          c.event_count,c.revision,(m.season_id IS NULL AND b.match_id IS NULL) AS season_unchecked
        FROM shared s JOIN matches m USING(match_id)
        LEFT JOIN telemetry_assets a USING(match_id)
        LEFT JOIN match_intensity_event_counts c USING(match_id)
        LEFT JOIN match_season_backfill_checks b USING(match_id)
        WHERE s.team_choice=1 AND m.shard_id='steam'
          AND m.game_mode IN ('duo','duo-fpp','squad','squad-fpp')""",
        (json.dumps(players), min_members),
    )
    days = defaultdict(list)
    for row in rows:
        if dt := _start_time(row["created_at"]):
            days[dt.date().isoformat()].append(row)
    for matches in days.values():
        matches.sort(key=lambda m: (_start_time(m["created_at"]), m["match_id"]))
    return days


def snapshots(db, keys):
    if not keys:
        return {}
    rows = db.execute(
        """SELECT s.* FROM json_each(?) k JOIN opponent_season_day_snapshots s
        ON (s.match_day,s.player_id,s.season_id,s.game_mode,s.ranked) =
           (k.value->>0,k.value->>1,k.value->>2,k.value->>3,k.value->>4)""",
        (json.dumps(sorted(keys)),),
    )
    return {tuple(r)[:5]: dict(r) for r in rows}


def profile_digest(rows):
    # Snapshots are immutable; their keys and observation times identify the sample.
    return digest(sorted((key, r["observed_at"]) for key, r in rows.items()))


@dataclass
class Day:
    payload: dict
    missing: set[ProfileKey]


def read_day(db, players, include_random, day, matches, min_members: int) -> Day:
    squad_key = f"{json.dumps(sorted(players))}|min={min_members}"
    ident = (squad_key, int(include_random), day, VERSION)
    source = digest([tuple(m) for m in matches])
    old = db.execute(
        """SELECT source_fingerprint,profile_fingerprint,payload_json
        FROM team_day_intensity_summaries
        WHERE squad_key=? AND include_random=? AND match_day=? AND calc_version=?""",
        ident,
    ).fetchone()
    if old and old[0] == source:
        cached = json.loads(old[2])
        keys = {tuple(k) for k in cached.pop("_profile_keys")}
        frozen = snapshots(db, keys)
        if old[1] == profile_digest(frozen):
            return Day({**cached, "from_disk_cache": True}, keys - frozen.keys())
    payload, keys, frozen = _compute(db, set(players), include_random, day, matches)
    encoded = json.dumps(
        {**payload, "_profile_keys": sorted(keys)}, ensure_ascii=False, separators=(",", ":")
    )
    with db:
        db.execute(
            # Do not let an older in-flight calculation overwrite a newer batch refresh.
            """INSERT INTO team_day_intensity_summaries VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(squad_key,include_random,match_day,calc_version) DO UPDATE SET
              source_fingerprint=excluded.source_fingerprint,
              profile_fingerprint=excluded.profile_fingerprint, match_count=excluded.match_count,
              payload_json=excluded.payload_json, updated_at=excluded.updated_at
            WHERE source_fingerprint=? AND profile_fingerprint=?""",
            (
                *ident,
                source,
                profile_digest(frozen),
                len(matches),
                encoded,
                time.time(),
                old[0] if old else None,
                old[1] if old else None,
            ),
        )
    return Day({**payload, "from_disk_cache": False}, keys - frozen.keys())


def _combat(db, mid, roster):
    """Keep only recorded cross-team events. V1/V2 can describe the same elimination."""
    stats = defaultdict(Counter)
    pairs = []
    null_damage = has_damage = False
    last_kill = {}
    for event in db.execute(
        """SELECT event_type,actor_player_id,victim_player_id,damage,elapsed_time
            FROM player_life_events WHERE match_id=? AND event_type IN
            ('LogPlayerKill','LogPlayerKillV2','LogPlayerTakeDamage','LogPlayerMakeGroggy')
            ORDER BY elapsed_time,id""",
        (mid,),
    ):
        kind, actor, victim, damage, elapsed = event
        if kind == DAMAGE:
            has_damage |= damage is not None
            null_damage |= damage is None
        if actor not in roster or victim not in roster or actor == victim:
            continue
        ta, tv = roster[actor]["known_team"], roster[victim]["known_team"]
        if not ta or not tv or ta == tv:
            continue
        if kind == DAMAGE:
            if damage is None or damage <= 0:
                continue
            stats[actor]["damage"] += damage
        elif kind in KILL_TYPES:
            previous = last_kill.get(victim)
            if previous and elapsed - previous[0] <= 1 and kind != previous[1]:
                continue
            last_kill[victim] = elapsed, kind
            stats[actor]["kills"] += 1
            stats[victim]["deaths"] += 1
        else:
            stats[actor]["knocks"] += 1
        pairs.append((kind, actor, victim, damage))
    return stats, pairs, has_damage, null_damage


def _compute(db, selected, include_random, day, matches):
    contacts, match_details = [], []
    members = defaultdict(Counter)
    names = {}
    maps, modes, populations, totals = Counter(), Counter(), Counter(), Counter()
    lobby_damage = []
    enemy_teams, high_teams, assessed_teams = set(), set(), set()
    keys = set()
    for m in matches:
        mid = m["match_id"]
        roster = {
            r["player_id"]: r
            for r in db.execute(
                """SELECT r.player_id,r.player_name,
            CASE WHEN t.is_unknown=0 AND t.team_id NOT IN ('unknown','')
                 THEN t.team_id END known_team
            FROM match_rosters r JOIN match_teams t USING(match_id,team_id) WHERE match_id=?""",
                (mid,),
            )
        }
        names.update({pid: r["player_name"] or pid for pid, r in roster.items()})
        teammates = {pid for pid, r in roster.items() if r["known_team"] == m["team_id"]}
        present_selected = selected & teammates
        actors = teammates if include_random else present_selected
        stats, events, has_damage, null_damage = _combat(db, mid, roster)
        ready = not null_damage and (
            has_damage
            or (
                m["parse_status"] == "completed" and m["parse_profile"] in ("full", "hotspot_light")
            )
        )
        totals["ready"] += ready
        totals["missing_season"] += not m["season_id"]
        ranked = int(m["match_type"] in ("competitive", "ranked"))
        totals["ranked"] += ranked
        rank = m["team_rank"]
        win, top3 = rank == 1, rank in (1, 2, 3)
        totals["wins"] += win
        totals["top3"] += top3
        maps[m["map_name"]] += 1
        modes[m["game_mode"]] += 1
        for pid in roster:
            populations[
                "human"
                if pid.startswith("account.")
                else "bot"
                if pid.startswith("ai.")
                else "unknown"
            ] += 1
            if ready:
                lobby_damage.append(stats[pid]["damage"])
        enemies = set()
        for kind, a, v, dmg in events:
            if a in actors and v.startswith("account."):
                enemies.add(v)
            if v in actors and a.startswith("account."):
                enemies.add(a)
            # Pressure and personal performance always describe the selected members.
            if a in present_selected and v.startswith("account."):
                totals["human_kills"] += kind in KILL_TYPES
                if ready and kind == DAMAGE:
                    totals["dealt"] += dmg
            if v in present_selected and a.startswith("account."):
                totals["human_deaths"] += kind in KILL_TYPES
                if ready and kind == DAMAGE:
                    totals["taken"] += dmg
        for pid in sorted(enemies):
            key = (day, pid, m["season_id"], m["game_mode"], ranked) if m["season_id"] else None
            if key:
                keys.add(key)
            team = mid, roster[pid]["known_team"]
            enemy_teams.add(team)
            damage = stats[pid]["damage"] if ready else None
            if ready:
                assessed_teams.add(team)
                if damage >= 300:
                    high_teams.add(team)
            contacts.append((pid, key, damage, stats[pid]["kills"]))
        for pid in present_selected:
            c = members[pid]
            c.update(stats[pid])
            if not ready:
                c["damage"] -= stats[pid]["damage"]
            c.update(
                dict(
                    match_count=1,
                    wins=win,
                    top3=top3,
                    rank_sum=rank or 0,
                    rank_count=rank is not None,
                )
            )
        match_details.append(
            dict(
                match_id=mid,
                created_at=m["created_at"],
                map_name=m["map_name"],
                game_mode=m["game_mode"],
                match_type=m["match_type"],
                team_rank=rank,
                kills=sum(stats[p]["kills"] for p in present_selected),
                damage=sum(stats[p]["damage"] for p in present_selected) if ready else None,
                players=[dict(player_id=p, player_name=names[p]) for p in sorted(present_selected)],
            )
        )

    frozen = snapshots(db, keys)
    profiles, details = _profiles(contacts, names, frozen)
    n = len(matches)
    fire = [d for _, _, d, _ in contacts if d is not None]
    total_players = sum(populations.values())
    payload = dict(
        summary=dict(
            date=day,
            match_count=n,
            first_match_at=matches[0]["created_at"],
            last_match_at=matches[-1]["created_at"],
            contacts_count=len(contacts),
            unique_opponents=len(details),
            enemy_teams=len(enemy_teams),
            maps=dict(maps),
            modes=dict(modes),
            normal_matches=n - totals["ranked"],
            ranked_matches=totals["ranked"],
            wins=totals["wins"],
            top3=totals["top3"],
        ),
        data_quality=dict(
            damage_ready_matches=totals["ready"],
            missing_damage_matches=n - totals["ready"],
            missing_season_matches=totals["missing_season"],
            season_backfill_pending=any(m["season_unchecked"] for m in matches),
        ),
        profiles=profiles,
        pressure=dict(
            opponent_damage_p50=percentile(fire, 0.5),
            opponent_damage_p75=percentile(fire, 0.75),
            opponent_avg_kills=ratio(sum(c[3] for c in contacts), len(contacts)),
            high_firepower_teams=len(high_teams),
            high_firepower_team_total=len(assessed_teams),
            high_firepower_team_rate=ratio(len(high_teams), len(assessed_teams)),
            team_kills_vs_humans=totals["human_kills"],
            team_deaths_to_humans=totals["human_deaths"],
            team_damage_taken_per_match=ratio(totals["taken"], totals["ready"]),
            team_damage_dealt_per_match=ratio(totals["dealt"], totals["ready"]),
        ),
        lobby=dict(
            total_players=total_players,
            human_count=populations["human"],
            bot_count=populations["bot"],
            unknown_count=populations["unknown"],
            bot_rate=ratio(populations["bot"], total_players),
            lobby_damage_p50=percentile(lobby_damage, 0.5),
            lobby_damage_p75=percentile(lobby_damage, 0.75),
        ),
        team_performance=dict(
            matches=match_details[::-1],
            members=[
                dict(
                    player_id=p,
                    player_name=names[p],
                    **{
                        k: c[k]
                        for k in ("match_count", "kills", "knocks", "deaths", "wins", "top3")
                    },
                    damage=c["damage"] if totals["ready"] else None,
                    avg_rank=ratio(c["rank_sum"], c["rank_count"]),
                )
                for p, c in sorted(members.items())
            ],
        ),
        opponents_detail=details,
    )
    return payload, keys, frozen


def _profiles(contacts, names, frozen):
    kds, adrs, observed = [], [], []
    missing = unavailable = 0
    by_pid = defaultdict(list)
    for pid, key, damage, kills in contacts:
        row = frozen.get(key)
        if row:
            if row["kd"] is not None:
                kds.append(row["kd"])
            if row["adr"] is not None:
                adrs.append(row["adr"])
            observed.append(row["observed_at"])
        elif key:
            missing += 1
        else:
            unavailable += 1
        by_pid[pid].append((key, row, damage, kills))
    ge2, ge3 = sum(v >= 2 for v in kds), sum(v >= 3 for v in kds)
    bands = [sum(v < 1 for v in kds), sum(1 <= v < 2 for v in kds), ge2 - ge3, ge3]
    profiles = dict(
        total_contacts=len(contacts),
        known_kd=len(kds),
        known_adr=len(adrs),
        kd_p25=percentile(kds, 0.25),
        kd_p50=percentile(kds, 0.5),
        kd_p75=percentile(kds, 0.75),
        kd_ge_2_count=ge2,
        kd_ge_2_rate=ratio(ge2, len(kds)),
        kd_ge_3_count=ge3,
        kd_ge_3_rate=ratio(ge3, len(kds)),
        kd_bands=[
            dict(label=label, count=c)
            for label, c in zip(("<1", "1–2", "2–3", "≥3"), bands, strict=True)
        ],
        adr_p50=percentile(adrs, 0.5),
        adr_p75=percentile(adrs, 0.75),
        observed_min_at=min(observed, default=None),
        observed_max_at=max(observed, default=None),
        missing_fillable_count=missing,
        unfillable_count=unavailable,
    )
    details = []
    for pid, rows in sorted(by_pid.items()):
        known = [r for _, r, _, _ in rows if r]
        kd = [r["kd"] for r in known if r["kd"] is not None]
        adr = [r["adr"] for r in known if r["adr"] is not None]
        dmg = [d for _, _, d, _ in rows if d is not None]
        details.append(
            dict(
                player_id=pid,
                player_name=names[pid],
                encounters=len(rows),
                kd=mean(kd) if kd else None,
                adr=mean(adr) if adr else None,
                match_damage_avg=mean(dmg) if dmg else None,
                match_kills_total=sum(r[3] for r in rows),
                observed_at=max((r["observed_at"] for r in known), default=None),
                profile_status="known"
                if len(known) == len(rows)
                else "partial"
                if known
                else "missing"
                if any(r[0] for r in rows)
                else "unfillable",
            )
        )
    return profiles, details


def trend_row(d):
    s, p = d["summary"], d["profiles"]
    return {
        **{k: s[k] for k in ("date", "match_count", "contacts_count", "unique_opponents", "maps")},
        "kd_p50": p["kd_p50"],
        "kd_known": p["known_kd"],
        "kd_total": p["total_contacts"],
        "adr_p50": p["adr_p50"],
        "opponent_damage_p50": d["pressure"]["opponent_damage_p50"],
        "team_damage_taken_per_match": d["pressure"]["team_damage_taken_per_match"],
        "bot_rate": d["lobby"]["bot_rate"],
        "from_disk_cache": d["from_disk_cache"],
    }


def warnings(days: list[dict], *, same_day: bool = False):
    result = []

    def warn(code, message):
        result.append({"code": code, "message": message})

    def mode_mix(summary):
        n = summary["match_count"]
        return summary["ranked_matches"] / n, {k: v / n for k, v in summary["modes"].items()}

    if same_day:
        warn("SAME_DAY", "两侧是同一天，无法判断日间变化。")
    if len(days) >= 2:
        summaries = [d["summary"] for d in days]
        subject = "两天" if len(days) == 2 else "所选日期"
        if not set.intersection(*(set(s["maps"]) for s in summaries)):
            warn("NO_MAP_OVERLAP", f"{subject}没有共同地图，比较时请留意地图差异。")
        first_mix = mode_mix(summaries[0])
        if any(mode_mix(s) != first_mix for s in summaries[1:]):
            warn("MODE_MIX_DIFFERS", f"{subject}的模式或排位占比不同。")
    if any(d["summary"]["match_count"] < 3 for d in days):
        warn("SMALL_SAMPLE", "部分日期不足三场，少数对局就会影响结果。")
    if any(d["profiles"]["known_kd"] < d["profiles"]["total_contacts"] * 0.5 for d in days):
        warn("LOW_COVERAGE", "部分日期已知 KD 的交手人次不足一半。")
    if any(d["data_quality"]["missing_season_matches"] for d in days):
        warn("MISSING_SEASON", "部分旧局缺少赛季，暂时不能匹配纸面战绩。")
    return result
