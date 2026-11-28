BEGIN;
ALTER TABLE matches ADD COLUMN season_id TEXT;
CREATE INDEX IF NOT EXISTS idx_match_rosters_player_match ON match_rosters(player_id, match_id);

CREATE TABLE opponent_season_day_snapshots (
    match_day TEXT NOT NULL, player_id TEXT NOT NULL, season_id TEXT NOT NULL,
    game_mode TEXT NOT NULL, ranked INTEGER NOT NULL CHECK (ranked IN (0, 1)),
    observed_at REAL NOT NULL, rounds INTEGER NOT NULL, kd REAL, adr REAL,
    PRIMARY KEY (match_day, player_id, season_id, game_mode, ranked)
) WITHOUT ROWID;
CREATE TABLE opponent_mastery_day_snapshots (
    match_day TEXT NOT NULL, player_id TEXT NOT NULL, observed_at REAL NOT NULL,
    tier INTEGER NOT NULL, level INTEGER NOT NULL, PRIMARY KEY (match_day, player_id)
) WITHOUT ROWID;
CREATE TABLE team_day_intensity_summaries (
    squad_key TEXT NOT NULL, include_random INTEGER NOT NULL DEFAULT 0 CHECK (include_random IN (0, 1)),
    match_day TEXT NOT NULL, calc_version INTEGER NOT NULL, source_fingerprint TEXT NOT NULL,
    profile_fingerprint TEXT NOT NULL, match_count INTEGER NOT NULL, payload_json TEXT NOT NULL,
    updated_at REAL NOT NULL, PRIMARY KEY (squad_key, include_random, match_day, calc_version)
) WITHOUT ROWID;
CREATE TABLE match_season_backfill_checks (
    match_id TEXT PRIMARY KEY, file_fingerprint TEXT NOT NULL, checked_at REAL NOT NULL
) WITHOUT ROWID;

-- Keep the source fingerprint O(matches) on warm reads; never rescan combat events.
-- The revision also tracks roster changes (names/teams/population affect the payload).
CREATE TABLE match_intensity_event_counts (
    match_id TEXT PRIMARY KEY, event_count INTEGER NOT NULL, revision INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO match_intensity_event_counts SELECT match_id, COUNT(*), 0 FROM player_life_events GROUP BY match_id;
CREATE TRIGGER intensity_roster_insert AFTER INSERT ON match_rosters BEGIN
    INSERT INTO match_intensity_event_counts VALUES(NEW.match_id,0,1)
    ON CONFLICT(match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER intensity_roster_delete AFTER DELETE ON match_rosters BEGIN
    INSERT INTO match_intensity_event_counts VALUES(OLD.match_id,0,1)
    ON CONFLICT(match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER intensity_roster_update AFTER UPDATE ON match_rosters BEGIN
    INSERT INTO match_intensity_event_counts VALUES(NEW.match_id,0,1)
    ON CONFLICT(match_id) DO UPDATE SET revision=revision+1;
    UPDATE match_intensity_event_counts SET revision=revision+1 WHERE match_id=OLD.match_id AND OLD.match_id<>NEW.match_id;
END;
CREATE TRIGGER intensity_known_team AFTER UPDATE OF is_unknown ON match_teams BEGIN
    INSERT INTO match_intensity_event_counts VALUES(NEW.match_id,0,1)
    ON CONFLICT(match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER intensity_event_insert AFTER INSERT ON player_life_events BEGIN
    INSERT INTO match_intensity_event_counts VALUES (NEW.match_id,1,1)
    ON CONFLICT(match_id) DO UPDATE SET event_count=event_count+1, revision=revision+1;
END;
CREATE TRIGGER intensity_event_delete AFTER DELETE ON player_life_events BEGIN
    UPDATE match_intensity_event_counts SET event_count=event_count-1, revision=revision+1 WHERE match_id=OLD.match_id;
END;
CREATE TRIGGER intensity_event_update AFTER UPDATE ON player_life_events BEGIN
    UPDATE match_intensity_event_counts SET event_count=event_count-1, revision=revision+1 WHERE match_id=OLD.match_id;
    INSERT INTO match_intensity_event_counts VALUES (NEW.match_id,1,1)
    ON CONFLICT(match_id) DO UPDATE SET event_count=event_count+1, revision=revision+1;
END;
