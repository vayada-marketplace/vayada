CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE hotels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    contact_email TEXT NOT NULL DEFAULT '',
    user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
