-- Migration 074: room_types.total_rooms becomes a derived mirror of
-- COUNT(rooms), maintained by a trigger (VAY-402).
--
-- Before this, total_rooms was a free-form field the Rooms & Rates form
-- wrote directly. Setting it higher than the number of physical `rooms`
-- instances inflated availability everywhere that reads it (booking engine
-- search & checkout, Channex ARI push, PMS dashboard occupancy, calendar,
-- room-block validation): the booking engine sold a room that had no
-- physical unit to assign, the guest completed the funnel, and the booking
-- failed at the payment step.
--
-- Fix: keep the total_rooms column (every read path keeps reading it
-- unchanged — the value is just always truthful now) but make it a
-- denormalized cache that ONLY a trigger on the rooms table writes. There
-- is then a single enforcement point covering every write path (admin Add
-- Room / delete, auto-create on room-type create, duplicate, listing
-- import) and no way for the count to diverge from reality.

-- 1. Self-heal legacy room types that have total_rooms > 0 but zero physical
--    room instances. Without this they would derive to 0 and silently go
--    Sold Out on deploy. Scaffold the missing room records named
--    "<Room Type Name> N" — same convention as
--    app/routers/admin_room_types._auto_create_rooms. ON CONFLICT guards the
--    unique (hotel_id, room_number) index; step 2 reconciles total_rooms to
--    whatever actually got created so the row stays self-consistent either
--    way.
INSERT INTO rooms (hotel_id, room_type_id, room_number, floor, status, sort_order)
SELECT rt.hotel_id,
       rt.id,
       rt.name || ' ' || gs.n,
       '',
       'available',
       gs.n - 1
FROM room_types rt
CROSS JOIN LATERAL generate_series(1, rt.total_rooms) AS gs(n)
WHERE rt.total_rooms > 0
  AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.room_type_id = rt.id)
ON CONFLICT (hotel_id, room_number) DO NOTHING;

-- 2. Backfill every room type to its real instance count. Fixes the
--    reported inflated case (total_rooms = 7, 6 real rooms -> 6) and
--    reconciles the rows scaffolded above.
UPDATE room_types rt
SET total_rooms = (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id = rt.id),
    updated_at = now();

-- 3. Trigger: recompute the owning room type's total_rooms whenever rooms
--    are inserted, deleted, or moved to a different room type. AFTER-row so
--    the COUNT sees the committed change. On room-type DELETE the ON DELETE
--    CASCADE removes its rooms and fires this per row; the UPDATE then
--    matches zero rows (parent already gone) — harmless.
CREATE OR REPLACE FUNCTION sync_room_type_total_rooms() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        UPDATE room_types
        SET total_rooms = (SELECT COUNT(*) FROM rooms WHERE room_type_id = OLD.room_type_id),
            updated_at = now()
        WHERE id = OLD.room_type_id;
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE') THEN
        IF NEW.room_type_id IS DISTINCT FROM OLD.room_type_id THEN
            UPDATE room_types
            SET total_rooms = (SELECT COUNT(*) FROM rooms WHERE room_type_id = OLD.room_type_id),
                updated_at = now()
            WHERE id = OLD.room_type_id;
            UPDATE room_types
            SET total_rooms = (SELECT COUNT(*) FROM rooms WHERE room_type_id = NEW.room_type_id),
                updated_at = now()
            WHERE id = NEW.room_type_id;
        END IF;
        RETURN NEW;
    ELSE  -- INSERT
        UPDATE room_types
        SET total_rooms = (SELECT COUNT(*) FROM rooms WHERE room_type_id = NEW.room_type_id),
            updated_at = now()
        WHERE id = NEW.room_type_id;
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_room_type_total_rooms ON rooms;
CREATE TRIGGER trg_sync_room_type_total_rooms
AFTER INSERT OR DELETE OR UPDATE OF room_type_id ON rooms
FOR EACH ROW EXECUTE FUNCTION sync_room_type_total_rooms();
