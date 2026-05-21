-- Individual rooms table
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
    room_number TEXT NOT NULL,
    floor TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'maintenance', 'out_of_order')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_rooms_hotel_number ON rooms(hotel_id, room_number);
CREATE INDEX idx_rooms_room_type ON rooms(room_type_id);

-- Add room assignment to bookings (nullable for existing bookings)
ALTER TABLE bookings ADD COLUMN room_id UUID REFERENCES rooms(id) ON DELETE SET NULL;
CREATE INDEX idx_bookings_room_id ON bookings(room_id);

-- Add booking channel/source
ALTER TABLE bookings ADD COLUMN channel TEXT NOT NULL DEFAULT 'direct';
