-- Migration 086: Persist the latest Channex ARI sync failure.
-- Lets PMS surface a visible warning when availability/rate pushes are rejected.

ALTER TABLE channex_connections
    ADD COLUMN IF NOT EXISTS last_ari_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS last_ari_sync_failed_at TIMESTAMPTZ;
