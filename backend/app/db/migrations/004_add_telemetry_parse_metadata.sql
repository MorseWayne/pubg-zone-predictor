ALTER TABLE telemetry_assets
    ADD COLUMN parse_profile TEXT;

ALTER TABLE telemetry_assets
    ADD COLUMN position_interval_seconds INTEGER;

ALTER TABLE telemetry_assets
    ADD COLUMN parsed_at TEXT;
