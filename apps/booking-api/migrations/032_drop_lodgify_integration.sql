-- Drop the Lodgify integration scaffold (originally added in 031).
-- The feature is being shelved until we have a concrete pilot; tracked
-- in the "Lodgify integration" Linear project. Re-introducing it later
-- means re-running the equivalent of 031 plus whatever the new design
-- requires.

DROP TABLE IF EXISTS lodgify_connections;

ALTER TABLE booking_hotels
    DROP COLUMN IF EXISTS pms_type;
