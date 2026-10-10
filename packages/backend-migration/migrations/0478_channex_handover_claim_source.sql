-- VAY-2108: the audited handover executor binds a migrated cohort hotel's Channex property to the
-- target with its own claim source (engineering/channex-per-hotel-ownership.md). The existing
-- sources keep their meaning; no policy, trigger or function changes.
SET LOCAL lock_timeout = '5s';
ALTER TABLE pms.channel_binding_claims
  DROP CONSTRAINT channel_binding_claims_claim_source_check,
  ADD CONSTRAINT channel_binding_claims_claim_source_check
    CHECK (claim_source IN ('migration', 'enable', 'adoption', 'repair', 'handover'));
