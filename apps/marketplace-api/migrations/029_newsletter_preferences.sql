-- ============================================
-- Newsletter preferences table
-- ============================================
-- Stores per-user weekly newsletter preferences.
-- Lives in the BUSINESS database (not auth) because
-- it references business entities (creators, hotels).

CREATE TABLE IF NOT EXISTS newsletter_preferences (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE,          -- references auth.users
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,  -- master opt-in/out
    country_filter  TEXT[] DEFAULT NULL,             -- NULL = all countries
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_preferences_user_id
    ON newsletter_preferences (user_id);

CREATE INDEX IF NOT EXISTS idx_newsletter_preferences_enabled
    ON newsletter_preferences (enabled) WHERE enabled = TRUE;
