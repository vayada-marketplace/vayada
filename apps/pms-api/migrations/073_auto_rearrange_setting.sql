-- Migration 073: per-hotel toggle for auto-rearranging room assignments.
--
-- When a new booking arrives and no single room of the requested type is free
-- across the full stay window, the solver in app/services/room_assignment.py
-- attempts to shuffle existing same-room-type bookings to free a slot before
-- falling back to "Unassigned" (VAY-397). Most properties want this — it's
-- the single most-requested calendar quality-of-life fix — but advanced users
-- who manually curate room assignments need an opt-out.
--
-- Default ON: the operational win outweighs the surprise factor, and any move
-- triggered by the solver is recorded as an `auto_rearranged` booking event so
-- staff can trace what happened.

ALTER TABLE hotels
    ADD COLUMN auto_rearrange_enabled BOOLEAN NOT NULL DEFAULT TRUE;
