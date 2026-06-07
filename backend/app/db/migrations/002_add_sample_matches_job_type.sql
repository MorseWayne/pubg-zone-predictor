CREATE TABLE IF NOT EXISTS ingest_jobs_new (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL CHECK (job_type IN (
        'tournament_list',
        'tournament_matches',
        'sample_matches',
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

INSERT INTO ingest_jobs_new (
    id,
    job_type,
    status,
    source_ref,
    total_count,
    success_count,
    skipped_count,
    failed_count,
    retry_count,
    started_at,
    finished_at,
    error_code,
    error_message
)
SELECT
    id,
    job_type,
    status,
    source_ref,
    total_count,
    success_count,
    skipped_count,
    failed_count,
    retry_count,
    started_at,
    finished_at,
    error_code,
    error_message
FROM ingest_jobs;

DROP TABLE ingest_jobs;

ALTER TABLE ingest_jobs_new RENAME TO ingest_jobs;

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status_started_at
    ON ingest_jobs (status, started_at);
