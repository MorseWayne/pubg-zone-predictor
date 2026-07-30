ALTER TABLE player_position_samples ADD COLUMN health REAL;

ALTER TABLE player_life_events ADD COLUMN damage_causer_name TEXT;

ALTER TABLE player_life_events ADD COLUMN damage_reason TEXT;

ALTER TABLE telemetry_assets
ADD COLUMN replay_schema_version INTEGER NOT NULL DEFAULT 0;
