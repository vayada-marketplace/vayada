-- Migration: 0506_pricing_v2_system_republish
-- Owner: domain-pms / VAY-2304
-- See: apps/api/src/domains/replacementPricingStore.ts, replacementChargeDeclarations.ts
--
-- A change to a hotel's payment setup (Vayada card on or off, its payment methods, its Stripe
-- account's readiness, or a release that changes the Finance fingerprint) stales its published
-- pricing-v2 prices, and guests see no offers until someone saves them again. VAY-2304 re-publishes
-- the last published prices with the new payment terms by itself. Those rows are the system's:
-- - pms.pricing_v2_revisions: actor_type ('user' or 'system') and republished_from, the revision
--   whose rooms and terms a system revision copies. A system revision has no actor_user_id.
-- - pms.pricing_v2_charge_declarations: actor_type and carried_from, the hotel's "all mandatory
--   charges included" declaration that a system copy carries onto the same prices. A system copy
--   has no user and no draft.
-- Existing rows become 'user' rows unchanged, and user rows still need every column they need today.
--
-- Rollback: before VAY-2304's re-publish ships, drop the columns and constraints and restore the
-- NOT NULLs. Once system rows exist they have no user, so keep the columns.

SET LOCAL lock_timeout = '5s';

ALTER TABLE pms.pricing_v2_revisions
  ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system')),
  ADD COLUMN republished_from INTEGER,
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD CONSTRAINT pricing_v2_revisions_actor CHECK (
    CASE actor_type
      WHEN 'user' THEN actor_user_id IS NOT NULL AND republished_from IS NULL
      ELSE actor_user_id IS NULL AND republished_from IS NOT NULL AND republished_from < revision
    END
  ),
  ADD CONSTRAINT pricing_v2_revisions_republished_from
    FOREIGN KEY (property_id, republished_from)
    REFERENCES pms.pricing_v2_revisions (property_id, revision);

ALTER TABLE pms.pricing_v2_charge_declarations
  ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system')),
  ADD COLUMN carried_from UUID REFERENCES pms.pricing_v2_charge_declarations (id),
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ALTER COLUMN draft_id DROP NOT NULL,
  ALTER COLUMN draft_revision DROP NOT NULL,
  ADD CONSTRAINT pricing_v2_charge_declarations_actor CHECK (
    CASE actor_type
      WHEN 'user' THEN actor_user_id IS NOT NULL AND draft_id IS NOT NULL
        AND draft_revision IS NOT NULL AND carried_from IS NULL
      ELSE actor_user_id IS NULL AND draft_id IS NULL AND draft_revision IS NULL
        AND carried_from IS NOT NULL
    END
  );
