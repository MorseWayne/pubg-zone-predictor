CREATE TABLE IF NOT EXISTS model_metrics_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_run_id TEXT NOT NULL,
    split TEXT NOT NULL DEFAULT 'train' CHECK (split IN ('train', 'validation')),
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
    UNIQUE (model_run_id, split, map_id, current_phase, target_type)
);

INSERT INTO model_metrics_new (
    id,
    model_run_id,
    split,
    map_id,
    current_phase,
    target_type,
    sample_count,
    mean_center_error,
    median_center_error,
    p90_center_error
)
SELECT
    id,
    model_run_id,
    'train',
    map_id,
    current_phase,
    target_type,
    sample_count,
    mean_center_error,
    median_center_error,
    p90_center_error
FROM model_metrics;

DROP TABLE model_metrics;

ALTER TABLE model_metrics_new RENAME TO model_metrics;

CREATE INDEX IF NOT EXISTS idx_model_metrics_model_run_id
    ON model_metrics (model_run_id);
