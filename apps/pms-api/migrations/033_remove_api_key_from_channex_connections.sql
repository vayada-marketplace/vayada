-- Migration 033: Remove per-hotel api_key from channex_connections
-- API key is now a platform-wide config (CHANNEX_API_KEY env var)

ALTER TABLE channex_connections DROP COLUMN IF EXISTS api_key;
