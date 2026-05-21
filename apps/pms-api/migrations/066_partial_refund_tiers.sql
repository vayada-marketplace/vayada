-- Migration 066: Tiered partial-refund schedule per room type (VAY-324)
--
-- Replaces the single (window, percent) pair on room_types with a list
-- of tiers stored as JSONB. A tier is `{min_days_before_check_in: int,
-- refund_percent: int}`. The list is read sorted descending by
-- min_days_before_check_in; refund logic picks the first matching tier
-- (i.e. the highest threshold the cancellation still meets).
--
-- The legacy partial_refund_cancel_window_days /
-- partial_refund_amount_percent columns stay around so old code paths
-- and any unmigrated rows keep working — when the tiers list is empty,
-- the booking-service refund computation falls back to the legacy pair.
-- This migration backfills the tiers list from the legacy pair for
-- every room currently set to flexible_cancellation_type='partial_refund'
-- so existing properties keep behaving identically until a hotelier
-- edits the schedule.

ALTER TABLE room_types
    ADD COLUMN IF NOT EXISTS partial_refund_tiers JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE room_types
   SET partial_refund_tiers = jsonb_build_array(
           jsonb_build_object(
               'min_days_before_check_in', partial_refund_cancel_window_days,
               'refund_percent', partial_refund_amount_percent
           )
       ),
       updated_at = now()
 WHERE flexible_cancellation_type = 'partial_refund'
   AND partial_refund_tiers = '[]'::jsonb;
