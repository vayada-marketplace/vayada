-- Per-room blocks: each room_block row now targets a specific room.
-- Legacy rows (blocks created before this migration) have room_id = NULL and
-- blocked_count >= 1; new rows set room_id and always have blocked_count = 1.
-- count_blocked() still SUMs blocked_count, so channel availability stays correct.
ALTER TABLE room_blocks
    ADD COLUMN room_id UUID REFERENCES rooms(id) ON DELETE CASCADE;

CREATE INDEX idx_room_blocks_room_id ON room_blocks(room_id);
