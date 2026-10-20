-- Migration: 0498_affiliate_program_drop
-- Owner: platform / VAY-2272 (Marketplace removal step 5, M-C, window W2 with 0499). HOLD: merge only
-- with Flamur's yes, after the counts-0498 before-runs.
--
-- Drops the retired affiliate program: all 38 of its tables in marketplace, booking and finance and
-- 24 of its functions, with every row: the percentage policy rates and the money records (earning
-- journal, allocations, payout payment evidence) too. Decision 2 (Flamur, 2026-10-20): delete
-- everything, no export. The legacy finance import (VAY-1358) records retired affiliate rows as
-- RETIRED_AFFILIATE_PROGRAM dispositions, which the dispositions reason-code CHECK now accepts.
-- Rows in the shared finance tables stay: payouts (an affiliate payout too), the affiliate commission
-- rules and billing entitlements, and the idempotency key of a recorded payment.
-- Rollback: any image built from main at or after f027728cc (no image since reads these tables). The
-- dropped data is gone and no rollback restores it.

SET LOCAL lock_timeout = '5s';
-- Each lock waits at most 5 seconds; together they may not hold the API up for more than 15.
SET LOCAL statement_timeout = '15s';

-- Every table this changes, in one statement and one order: the dropped tables, every table one of
-- them references (dropping a foreign key removes its triggers there) and the dispositions table.
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
  platform.idempotency_keys, platform.product_audit_events, platform.production_finance_migration_dispositions,
  pms.operational_booking_assignments
  IN ACCESS EXCLUSIVE MODE;

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
  finance.affiliate_payout_payment_evidence_items, finance.affiliate_payout_payment_evidence,
  finance.affiliate_earning_allocation_items, finance.affiliate_earning_allocations, finance.affiliate_earning_journal,
  finance.affiliate_earning_reconciliation_revisions, finance.affiliate_eligible_earning_revisions,
  finance.affiliate_percentage_policy_approvals, finance.affiliate_percentage_policy_versions;

DROP FUNCTION
  booking.complete_affiliate_referral_production_preflight(), booking.complete_affiliate_source_capability_preflight(),
  booking.lock_affiliate_referral_production_preflight_revocation(), booking.lock_affiliate_source_capability_preflight_revocation(),
  booking.lock_affiliate_validation_probe_for_revocation(), booking.prevent_duplicate_affiliate_probe_binding(),
  booking.reject_affiliate_click_context_mutation(), booking.reject_affiliate_original_binding_mutation(),
  booking.reject_synthetic_binding_with_earning(), booking.try_affiliate_booking_uuid(text),
  booking.valid_affiliate_certification_references(jsonb), booking.verify_affiliate_referral_transport_certification(),
  booking.verify_affiliate_source_capability_certification(),
  finance.guard_affiliate_earning_allocation_evidence(), finance.reject_affiliate_validation_probe_earning(),
  finance.reject_synthetic_original_booking_earning(), finance.validate_affiliate_payout_payment_evidence_aggregate(),
  finance.validate_affiliate_payout_payment_evidence_item(),
  marketplace.reject_affiliate_click_occurrence_mutation(), marketplace.reject_affiliate_offer_draft_mutation(),
  marketplace.stamp_affiliate_agreement_lifecycle_event(), marketplace.valid_affiliate_claim_references(jsonb),
  marketplace.validate_affiliate_discrepancy_claim(), marketplace.validate_affiliate_discrepancy_resolution();

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

-- Indexes are not checked: two on finance.commission_rules carry the name and stay.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('marketplace', 'booking', 'finance') AND c.relname LIKE '%affiliate%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('marketplace', 'booking', 'finance') AND p.proname LIKE '%affiliate%'
  ) THEN
    RAISE EXCEPTION 'Affiliate objects remain';
  END IF;
END $$;
