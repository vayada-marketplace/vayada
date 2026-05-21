ALTER TABLE booking_hotels ADD COLUMN custom_domain TEXT UNIQUE;
CREATE INDEX idx_booking_hotels_custom_domain ON booking_hotels(custom_domain);
