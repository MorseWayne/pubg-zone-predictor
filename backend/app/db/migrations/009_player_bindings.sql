CREATE TABLE player_bindings (
    player_id TEXT NOT NULL PRIMARY KEY,
    player_name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
);

CREATE UNIQUE INDEX one_active_player ON player_bindings(is_active) WHERE is_active = 1;
