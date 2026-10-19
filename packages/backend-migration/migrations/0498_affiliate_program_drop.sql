-- Migration: 0498_affiliate_program_drop
-- Owner: platform / VAY-2272 (Marketplace removal step 5, M-C, window W2 with 0499). HOLD: merge only
-- with Flamur's yes, after the counts-0498 before-runs.
--
-- Drops the retired affiliate program: 31 of its 38 tables in marketplace, booking and finance and
-- 21 of its functions. Law variant (decision 2): production recorded an affiliate payment, so seven
-- finance tables stay as a read-only archive with their payee names: the earning journal, the
-- earning allocations and their items, the payout payment evidence and its items, and the
-- percentage policy versions and approvals (the hotel-chosen rates behind the kept money; the
-- allocations name them by id). They reference no dropped table and keep their own guards. The
-- journal's two insert-time validators read booking tables that go away, so they go first.
-- The legacy finance import (VAY-1358) records retired affiliate rows as RETIRED_AFFILIATE_PROGRAM
-- dispositions, which the dispositions reason-code CHECK now accepts.
-- Rollback: any image built from main at or after f027728cc (no image since reads these tables). The
-- dropped data is gone and no rollback restores it.

SET LOCAL lock_timeout = '5s';

-- Every table this changes, in one statement and one order: the dropped tables, every table one of
-- them references (dropping a foreign key removes its triggers there), the archive and the
-- dispositions table.
LOCK TABLE
  booking.affiliate_click_admissions, booking.affiliate_click_contexts, booking.affiliate_destination_versions,
  booking.affiliate_original_booking_bindings, booking.affiliate_referral_production_preflight_revocations,
  booking.affiliate_referral_production_preflights, booking.affiliate_referral_transport_certifications,
  booking.affiliate_source_capability_certifications, booking.affiliate_source_capability_preflight_revocations,
  booking.affiliate_source_capability_production_preflights, booking.affiliate_validation_booking_bindings,
  booking.affiliate_validation_probe_revocations, booking.affiliate_validation_probes, booking.guest_bookings,
  finance.affiliate_earning_allocation_items, finance.affiliate_earning_allocations, finance.affiliate_earning_journal,
  finance.affiliate_earning_reconciliation_revisions, finance.affiliate_eligible_earning_revisions,
  finance.affiliate_payout_payment_evidence, finance.affiliate_payout_payment_evidence_items,
  finance.affiliate_percentage_policy_approvals, finance.affiliate_percentage_policy_versions, finance.payouts,
  hotel_catalog.properties, identity.organizations, identity.users,
  marketplace.affiliate_agreement_activations, marketplace.affiliate_agreement_lifecycle_events, marketplace.affiliate_agreements,
  marketplace.affiliate_assent_decisions, marketplace.affiliate_click_occurrences, marketplace.affiliate_click_quota_windows,
  marketplace.affiliate_discrepancy_claims, marketplace.affiliate_discrepancy_resolutions, marketplace.affiliate_lifecycle_changes,
  marketplace.affiliate_links, marketplace.affiliate_offer_terms_drafts, marketplace.affiliate_participation_attempts,
  marketplace.affiliate_participations, marketplace.affiliate_programs, marketplace.affiliate_published_terms,
  marketplace.creator_profiles, marketplace.marketplace_offers, marketplace.property_affiliates,
  platform.product_audit_events, platform.production_finance_migration_dispositions,
  pms.operational_booking_assignments
  IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER affiliate_earning_journal_reject_validation_probe ON finance.affiliate_earning_journal;
DROP TRIGGER affiliate_earning_journal_reject_synthetic_original ON finance.affiliate_earning_journal;

DROP TABLE
  marketplace.affiliate_discrepancy_resolutions, marketplace.affiliate_discrepancy_claims,
  marketplace.affiliate_click_quota_windows, marketplace.affiliate_click_occurrences, marketplace.affiliate_links,
  marketplace.affiliate_agreement_lifecycle_events, marketplace.affiliate_agreement_activations,
  marketplace.affiliate_agreements, marketplace.affiliate_assent_decisions, marketplace.affiliate_participation_attempts,
  marketplace.affiliate_participations, marketplace.affiliate_published_terms, marketplace.affiliate_offer_terms_drafts,
  marketplace.affiliate_programs, marketplace.affiliate_lifecycle_changes, marketplace.property_affiliates,
  booking.affiliate_original_booking_bindings, booking.affiliate_click_admissions, booking.affiliate_click_contexts,
  booking.affiliate_destination_versions, booking.affiliate_referral_production_preflight_revocations,
  booking.affiliate_referral_production_preflights, booking.affiliate_referral_transport_certifications,
  booking.affiliate_source_capability_preflight_revocations, booking.affiliate_source_capability_production_preflights,
  booking.affiliate_source_capability_certifications, booking.affiliate_validation_booking_bindings,
  booking.affiliate_validation_probe_revocations, booking.affiliate_validation_probes,
  finance.affiliate_earning_reconciliation_revisions, finance.affiliate_eligible_earning_revisions;

DROP FUNCTION
  booking.complete_affiliate_referral_production_preflight(), booking.complete_affiliate_source_capability_preflight(),
  booking.lock_affiliate_referral_production_preflight_revocation(), booking.lock_affiliate_source_capability_preflight_revocation(),
  booking.lock_affiliate_validation_probe_for_revocation(), booking.prevent_duplicate_affiliate_probe_binding(),
  booking.reject_affiliate_click_context_mutation(), booking.reject_affiliate_original_binding_mutation(),
  booking.reject_synthetic_binding_with_earning(), booking.try_affiliate_booking_uuid(text),
  booking.valid_affiliate_certification_references(jsonb), booking.verify_affiliate_referral_transport_certification(),
  booking.verify_affiliate_source_capability_certification(),
  finance.reject_affiliate_validation_probe_earning(), finance.reject_synthetic_original_booking_earning(),
  marketplace.reject_affiliate_click_occurrence_mutation(), marketplace.reject_affiliate_offer_draft_mutation(),
  marketplace.stamp_affiliate_agreement_lifecycle_event(), marketplace.valid_affiliate_claim_references(jsonb),
  marketplace.validate_affiliate_discrepancy_claim(), marketplace.validate_affiliate_discrepancy_resolution();

-- No code writes the archive any more, and the law keeps its rows as they are: every write fails.
CREATE TRIGGER affiliate_earning_journal_retired_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON finance.affiliate_earning_journal
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_earning_allocations_retired_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON finance.affiliate_earning_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_earning_allocation_items_retired_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON finance.affiliate_earning_allocation_items
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_payout_payment_evidence_retired_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON finance.affiliate_payout_payment_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_payout_payment_evidence_items_retired_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON finance.affiliate_payout_payment_evidence_items
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_percentage_policy_versions_retired_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON finance.affiliate_percentage_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_percentage_policy_approvals_retired_read_only
  BEFORE INSERT OR UPDATE OR DELETE ON finance.affiliate_percentage_policy_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

ALTER TABLE platform.production_finance_migration_dispositions
  DROP CONSTRAINT production_finance_migration_dispositions_reason_code_check,
  ADD CONSTRAINT production_finance_migration_dispositions_reason_code_check CHECK (reason_code IN (
    'INVALID_FINANCE_SOURCE_ROW',
    'INVALID_BOOKING_FINANCE_ALLOCATION',
    'BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED',
    'PAYMENT_CAPTURE_EVIDENCE_REQUIRED',
    'MISSING_PAYMENT_PROVIDER_ACCOUNT_ID',
    'LEGACY_PAYMENT_PROVIDER_REFERENCE_QUARANTINED',
    'LEGACY_BILLING_PROVIDER_REFERENCE_QUARANTINED',
    'FINANCE_PARENT_RECORD_QUARANTINED',
    'MISSING_PROVIDER_ACCOUNT_ID',
    'MISSING_PAYOUT_PROVIDER_ACCOUNT_ID',
    'PAYMENT_SETTINGS_SOURCE_DISAGREEMENT',
    'BANK_TRANSFER_DESTINATION_REENTRY_REQUIRED',
    'PAYPAL_DESTINATION_REENTRY_REQUIRED',
    'SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED',
    'PAYOUT_PAYMENT_ALLOCATION_EVIDENCE_REQUIRED',
    'NONCANONICAL_BOOKING_ENGINE_FEE',
    'NONCANONICAL_FIXED_PLAN_PRICING',
    'FIXED_PLAN_PROVIDER_REBIND_REQUIRED',
    'BILLING_PLAN_PROVIDER_STATE_DISAGREEMENT',
    'FIXED_PLAN_SUBSCRIPTION_EVIDENCE_REQUIRED',
    'FIXED_PLAN_BILLING_PRICE_DIRTY',
    'FIXED_PLAN_BILLING_PRICE_EVIDENCE_REQUIRED',
    'INVALID_FIXED_PLAN_BILLING_EVIDENCE',
    'FIXED_PLAN_BILLING_AMOUNT_MISMATCH',
    'RETIRED_AFFILIATE_PROGRAM'
  ));

DO $$
DECLARE
  archive CONSTANT text[] := ARRAY[
    'affiliate_earning_journal', 'affiliate_earning_allocations', 'affiliate_earning_allocation_items',
    'affiliate_payout_payment_evidence', 'affiliate_payout_payment_evidence_items',
    'affiliate_percentage_policy_versions', 'affiliate_percentage_policy_approvals'];
  guards CONSTANT text[] := ARRAY[
    'guard_affiliate_earning_allocation_evidence', 'validate_affiliate_payout_payment_evidence_aggregate',
    'validate_affiliate_payout_payment_evidence_item'];
BEGIN
  -- Indexes are not checked: the archive tables' own and two on finance.commission_rules carry the
  -- name and stay.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('marketplace', 'booking', 'finance') AND c.relname LIKE '%affiliate%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT (n.nspname = 'finance' AND c.relname = ANY (archive))
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('marketplace', 'booking', 'finance') AND p.proname LIKE '%affiliate%'
      AND NOT (n.nspname = 'finance' AND p.proname = ANY (guards))
  ) THEN
    RAISE EXCEPTION 'Affiliate objects outside the finance archive remain';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'finance' AND c.relkind = 'r' AND c.relname = ANY (archive)) <> 7
    OR (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'finance' AND p.proname = ANY (guards)) <> 3
    OR (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'finance' AND c.relname = ANY (archive)
          AND t.tgname = c.relname || '_retired_read_only') <> 7
  THEN
    RAISE EXCEPTION 'The affiliate money archive is incomplete';
  END IF;
END $$;
