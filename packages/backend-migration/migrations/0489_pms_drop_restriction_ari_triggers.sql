-- Migration: 0489_pms_drop_restriction_ari_triggers
-- Owner: domain-pms / VAY-2208
--
-- Restriction-only Channex ARI has had no sender since #1764: every job these triggers queue ends
-- in PRICING_UNAVAILABLE, and production never claims them while ARI is observe_only. Drop the
-- rate-rule and operating-calendar triggers from 0167 and their function (last redefined in 0177).
-- - Keep pms.enqueue_restriction_ari(uuid,text): the platform runtime preflight, the runtime and
--   worker grant scripts and the Channex worker boundary still require it.
-- - Keep the 0166 stay-restriction functions and validate/lock triggers: booking quotes still
--   enforce pms.rate_rules.
-- - Restriction-only jobs already queued stay as they are.
-- The Channex worker catalog digest for this state is accepted by images from VAY-2208 PR3 on, so
-- ship this in a coordinated release after that image is live.

SET LOCAL lock_timeout = '5s';

DROP TRIGGER pms_restriction_ari_changed ON pms.rate_rules;
DROP TRIGGER pms_calendar_restriction_ari_changed ON pms.operating_calendar_revisions;
DROP FUNCTION pms.restriction_ari_changed();
