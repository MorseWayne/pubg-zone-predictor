ALTER TABLE player_position_samples
ADD COLUMN movement_mode TEXT
CHECK (movement_mode IS NULL OR movement_mode IN ('foot', 'vehicle'));

ALTER TABLE player_position_samples ADD COLUMN vehicle_type TEXT;

ALTER TABLE player_position_samples ADD COLUMN vehicle_id TEXT;

ALTER TABLE player_position_samples ADD COLUMN vehicle_seat_index INTEGER;
