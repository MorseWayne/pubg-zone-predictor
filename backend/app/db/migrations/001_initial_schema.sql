CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at TEXT,
    source TEXT,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tournaments_type_created_at
    ON tournaments (type, created_at);

CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    tournament_id TEXT,
    map_name TEXT NOT NULL,
    shard_id TEXT,
    game_mode TEXT,
    match_type TEXT,
    created_at TEXT,
    duration INTEGER,
    telemetry_url TEXT,
    ingest_status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    FOREIGN KEY (tournament_id) REFERENCES tournaments (id)
        ON UPDATE CASCADE
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_tournament_created_at
    ON matches (tournament_id, created_at);

CREATE INDEX IF NOT EXISTS idx_matches_map_created_at
    ON matches (map_name, created_at);

CREATE TABLE IF NOT EXISTS telemetry_assets (
    match_id TEXT PRIMARY KEY,
    telemetry_url TEXT NOT NULL,
    cache_path TEXT,
    content_hash TEXT,
    downloaded_at TEXT,
    parse_status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    FOREIGN KEY (match_id) REFERENCES matches (match_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_telemetry_assets_telemetry_url
    ON telemetry_assets (telemetry_url);

CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL CHECK (job_type IN (
        'tournament_list',
        'tournament_matches',
        'telemetry_download',
        'telemetry_parse'
    )),
    status TEXT NOT NULL CHECK (status IN (
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled'
    )),
    source_ref TEXT,
    total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
    success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
    skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status_started_at
    ON ingest_jobs (status, started_at);

CREATE TABLE IF NOT EXISTS match_teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    team_rank INTEGER,
    is_unknown INTEGER NOT NULL DEFAULT 0 CHECK (is_unknown IN (0, 1)),
    FOREIGN KEY (match_id) REFERENCES matches (match_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    UNIQUE (match_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_match_teams_match_id
    ON match_teams (match_id);

CREATE TABLE IF NOT EXISTS match_rosters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT,
    FOREIGN KEY (match_id) REFERENCES matches (match_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (match_id, team_id) REFERENCES match_teams (match_id, team_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    UNIQUE (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_match_rosters_match_team
    ON match_rosters (match_id, team_id);

CREATE TABLE IF NOT EXISTS circle_phases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    phase INTEGER NOT NULL CHECK (phase BETWEEN 1 AND 8),
    elapsed_time REAL NOT NULL CHECK (elapsed_time >= 0),
    center_x REAL NOT NULL,
    center_y REAL NOT NULL,
    radius REAL NOT NULL CHECK (radius >= 0),
    num_alive_teams INTEGER CHECK (num_alive_teams >= 0),
    num_alive_players INTEGER CHECK (num_alive_players >= 0),
    FOREIGN KEY (match_id) REFERENCES matches (match_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    UNIQUE (match_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_circle_phases_match_phase
    ON circle_phases (match_id, phase);

CREATE TABLE IF NOT EXISTS player_position_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    phase INTEGER CHECK (phase BETWEEN 1 AND 8),
    elapsed_time REAL NOT NULL CHECK (elapsed_time >= 0),
    elapsed_time_bucket INTEGER NOT NULL CHECK (elapsed_time_bucket >= 0),
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL,
    alive INTEGER CHECK (alive IS NULL OR alive IN (0, 1)),
    FOREIGN KEY (match_id) REFERENCES matches (match_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (match_id, team_id) REFERENCES match_teams (match_id, team_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    FOREIGN KEY (match_id, player_id) REFERENCES match_rosters (match_id, player_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    UNIQUE (match_id, player_id, elapsed_time_bucket)
);

CREATE INDEX IF NOT EXISTS idx_player_position_samples_match_phase
    ON player_position_samples (match_id, phase);

CREATE INDEX IF NOT EXISTS idx_player_position_samples_team_phase
    ON player_position_samples (match_id, team_id, phase);

CREATE TABLE IF NOT EXISTS player_life_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    elapsed_time REAL NOT NULL CHECK (elapsed_time >= 0),
    phase INTEGER CHECK (phase BETWEEN 1 AND 8),
    event_type TEXT NOT NULL,
    actor_player_id TEXT,
    victim_player_id TEXT,
    x REAL,
    y REAL,
    FOREIGN KEY (match_id) REFERENCES matches (match_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_life_events_dedupe
    ON player_life_events (
        match_id,
        elapsed_time,
        event_type,
        IFNULL(actor_player_id, ''),
        IFNULL(victim_player_id, ''),
        IFNULL(x, -1),
        IFNULL(y, -1)
    );

CREATE INDEX IF NOT EXISTS idx_player_life_events_match_phase
    ON player_life_events (match_id, phase);

CREATE TABLE IF NOT EXISTS model_runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    maps_included TEXT NOT NULL,
    phases_included TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
    algorithm TEXT NOT NULL,
    model_path TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled'
    ))
);

CREATE INDEX IF NOT EXISTS idx_model_runs_created_at_status
    ON model_runs (created_at, status);

CREATE TABLE IF NOT EXISTS hotspot_tiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id TEXT NOT NULL,
    phase INTEGER NOT NULL CHECK (phase BETWEEN 1 AND 8),
    grid_size INTEGER NOT NULL DEFAULT 64 CHECK (grid_size > 0),
    tile_x INTEGER NOT NULL CHECK (tile_x >= 0),
    tile_y INTEGER NOT NULL CHECK (tile_y >= 0),
    density_score REAL NOT NULL DEFAULT 0 CHECK (density_score BETWEEN 0 AND 1),
    kill_death_score REAL NOT NULL DEFAULT 0 CHECK (kill_death_score BETWEEN 0 AND 1),
    hotspot_score REAL NOT NULL DEFAULT 0 CHECK (hotspot_score BETWEEN 0 AND 1),
    sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
    generated_from_model_run_id TEXT,
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (generated_from_model_run_id) REFERENCES model_runs (id)
        ON UPDATE CASCADE
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hotspot_tiles_lookup
    ON hotspot_tiles (
        map_id,
        phase,
        grid_size,
        tile_x,
        tile_y,
        generated_at,
        generated_from_model_run_id
    );

CREATE TABLE IF NOT EXISTS model_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_run_id TEXT NOT NULL,
    map_id TEXT NOT NULL,
    current_phase INTEGER NOT NULL CHECK (current_phase BETWEEN 1 AND 7),
    target_type TEXT NOT NULL CHECK (target_type IN ('next', 'final')),
    sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
    mean_center_error REAL NOT NULL CHECK (mean_center_error >= 0),
    median_center_error REAL NOT NULL CHECK (median_center_error >= 0),
    p90_center_error REAL CHECK (p90_center_error IS NULL OR p90_center_error >= 0),
    FOREIGN KEY (model_run_id) REFERENCES model_runs (id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    UNIQUE (model_run_id, map_id, current_phase, target_type)
);

CREATE INDEX IF NOT EXISTS idx_model_metrics_model_run_id
    ON model_metrics (model_run_id);
