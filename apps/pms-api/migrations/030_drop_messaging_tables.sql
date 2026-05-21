-- Migration 030: Remove messaging tables (Channex does not support OTA messaging)

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS message_sync_state;
