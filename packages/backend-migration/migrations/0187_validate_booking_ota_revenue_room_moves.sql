-- Migration: 0187_validate_booking_ota_revenue_room_moves; owner: domain-booking; see VAY-1185
ALTER TABLE booking.nightly_revenue_evidence VALIDATE CONSTRAINT chk_booking_nightly_revenue_evidence_event;
