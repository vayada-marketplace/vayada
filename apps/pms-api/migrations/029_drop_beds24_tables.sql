-- Migration 029: Remove Beds24 channel manager tables (replaced by Channex)

DROP TABLE IF EXISTS beds24_booking_mappings;
DROP TABLE IF EXISTS beds24_room_mappings;
DROP TABLE IF EXISTS beds24_connections;
