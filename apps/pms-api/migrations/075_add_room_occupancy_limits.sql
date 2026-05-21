ALTER TABLE room_types
    ADD COLUMN IF NOT EXISTS max_adults INTEGER,
    ADD COLUMN IF NOT EXISTS max_children INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'room_types_max_adults_positive'
    ) THEN
        ALTER TABLE room_types
            ADD CONSTRAINT room_types_max_adults_positive
            CHECK (max_adults IS NULL OR max_adults >= 1);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'room_types_max_children_nonnegative'
    ) THEN
        ALTER TABLE room_types
            ADD CONSTRAINT room_types_max_children_nonnegative
            CHECK (max_children IS NULL OR max_children >= 0);
    END IF;
END $$;
