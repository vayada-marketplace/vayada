-- Migration 068: Guest-initiated booking change requests (VAY-379).
--
-- Guests can request edits (dates, add-ons) to a confirmed booking. The
-- change is not applied until the hotel approves it. We persist each
-- request as a row in `booking_change_requests` so the workflow has an
-- audit trail and so the approve/decline links in the host email stay
-- valid even if the guest navigates away.
--
-- Concurrency rule: only one pending change request may exist per
-- booking at a time. Enforced by a partial unique index on
-- (booking_id) WHERE status = 'pending'.

CREATE TABLE IF NOT EXISTS booking_change_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    -- Snapshot of the booking at request time, so the host email + PMS
    -- screen can show "current vs requested" even if the booking row is
    -- mutated later by an admin edit.
    old_check_in DATE NOT NULL,
    old_check_out DATE NOT NULL,
    old_addon_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    old_addon_quantities JSONB NOT NULL DEFAULT '{}'::jsonb,
    old_addon_dates JSONB NOT NULL DEFAULT '{}'::jsonb,
    old_total NUMERIC(12, 2) NOT NULL,
    -- Requested deltas (full new values, not deltas — simpler to apply).
    requested_check_in DATE NOT NULL,
    requested_check_out DATE NOT NULL,
    requested_addon_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    requested_addon_quantities JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_addon_dates JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_nightly_rate NUMERIC(12, 4) NOT NULL,
    requested_addon_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
    requested_addon_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    new_total NUMERIC(12, 2) NOT NULL,
    price_difference NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL,
    -- Token included in the host email's approve/decline buttons so the
    -- public action links don't need the guest's session.
    decision_token UUID NOT NULL DEFAULT gen_random_uuid(),
    decline_reason TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_change_requests_booking_id
    ON booking_change_requests(booking_id, created_at DESC);

-- Partial unique index: at most one pending change request per booking.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_change_requests_one_pending
    ON booking_change_requests(booking_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_booking_change_requests_decision_token
    ON booking_change_requests(decision_token);
