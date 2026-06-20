-- Add direction fields for IDBlock Next Facial equipment
-- This allows IDBlock Next, IDBlock Next Facial, and IDBlock Facial to work with direction-based entry/exit
-- Instead of marking equipment as exit, we configure the direction (left/right) for entry and exit

ALTER TABLE equipments ADD COLUMN direction_entrada TEXT;
ALTER TABLE equipments ADD COLUMN direction_saida TEXT;

-- Index for direction queries
CREATE INDEX IF NOT EXISTS idx_equipments_direction ON equipments(direction_entrada, direction_saida);
