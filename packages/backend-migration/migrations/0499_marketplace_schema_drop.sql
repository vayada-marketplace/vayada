-- Migration: 0499_marketplace_schema_drop
-- Owner: platform / VAY-2272 (Marketplace removal step 5, M-D, window W2 with 0498). Held by hand:
-- merged with Flamur's yes, after the counts-0499 before-runs, with platform P1 applied and its
-- inspect passing (the runtime preflight and product DML grant tolerate the dropped schema).
--
-- Drops what is left of the Marketplace: the 0496 hotel-invite compatibility view, the 31 remaining
-- marketplace tables, the legacy Marketplace import's quarantine table, 20 marketplace functions and
-- the quarantine guard, then the marketplace schema itself. The staged legacy copies
-- (migration_source_*) stay: the hotel import reads the Marketplace hotel profiles there (decision 8).
-- It also drops the Marketplace matching-event payload check on platform.domain_events (0142), which it
-- locks anyway; the matching events that exist keep their payloads.
-- Rollback: any image from the 0496 release on (older images read marketplace.invite_codes). The data
-- is gone and no rollback restores it.

SET LOCAL lock_timeout = '5s';
-- Each lock waits at most 5 seconds; together they may not hold the API up for more than 15.
SET LOCAL statement_timeout = '15s';

-- Not the view: locking a view also locks its base table, hotel_catalog.hotel_account_invites.
LOCK TABLE
  finance.commission_rules, hotel_catalog.properties, identity.organizations, identity.users,
  marketplace.active_hotel_submission_revisions, marketplace.collaboration_deliverables, marketplace.collaborations,
  marketplace.communication_channel_preferences, marketplace.communication_preference_sets,
  marketplace.communication_topic_preferences, marketplace.creator_matching_preferences,
  marketplace.creator_platform_authorizations, marketplace.creator_platform_connections,
  marketplace.creator_platform_credential_cleanup_jobs, marketplace.creator_platform_metric_snapshots,
  marketplace.creator_platforms, marketplace.creator_profiles, marketplace.creator_ratings, marketplace.current_matching_outcomes,
  marketplace.external_collaborations, marketplace.hotel_collaboration_preferences, marketplace.hotel_submission_moderation,
  marketplace.hotel_submission_revisions, marketplace.marketplace_chat_messages, marketplace.marketplace_hotel_profiles,
  marketplace.marketplace_notifications, marketplace.marketplace_offer_read_model, marketplace.marketplace_offers,
  marketplace.matching_event_projections, marketplace.newsletter_preferences, marketplace.offer_compensation_options,
  marketplace.offer_creator_requirements, marketplace.offer_deliverables, marketplace.offer_matching_criteria, marketplace.trips,
  platform.domain_events, platform.production_marketplace_migration_quarantines, platform.source_extraction_runs
  IN ACCESS EXCLUSIVE MODE;

DROP VIEW marketplace.invite_codes;

DROP TABLE
  marketplace.current_matching_outcomes, marketplace.matching_event_projections, marketplace.creator_ratings,
  marketplace.marketplace_chat_messages, marketplace.collaboration_deliverables, marketplace.collaborations,
  marketplace.external_collaborations, marketplace.trips, marketplace.creator_platform_metric_snapshots,
  marketplace.creator_platform_connections, marketplace.creator_platform_authorizations,
  marketplace.creator_platform_credential_cleanup_jobs, marketplace.creator_platforms, marketplace.creator_matching_preferences,
  marketplace.communication_channel_preferences, marketplace.communication_topic_preferences,
  marketplace.communication_preference_sets, marketplace.newsletter_preferences, marketplace.marketplace_notifications,
  marketplace.active_hotel_submission_revisions, marketplace.hotel_submission_moderation, marketplace.hotel_submission_revisions,
  marketplace.hotel_collaboration_preferences, marketplace.offer_matching_criteria, marketplace.offer_deliverables,
  marketplace.offer_creator_requirements, marketplace.offer_compensation_options, marketplace.marketplace_offer_read_model,
  marketplace.marketplace_offers, marketplace.marketplace_hotel_profiles, marketplace.creator_profiles,
  platform.production_marketplace_migration_quarantines;

DROP FUNCTION
  marketplace.creator_profile_is_complete(uuid, uuid), marketplace.enforce_creator_matching_preferences_revision(),
  marketplace.enforce_current_matching_outcome_transition(), marketplace.enforce_hotel_collaboration_preferences_revision(),
  marketplace.enforce_matching_collaboration_attribution(), marketplace.enforce_matching_event_envelope(),
  marketplace.enforce_offer_matching_criteria_revision(), marketplace.guard_communication_preference(),
  marketplace.hotel_collaboration_preference_months_are_canonical(smallint[]),
  marketplace.hotel_collaboration_preference_selection_is_canonical(text[], text[]),
  marketplace.jsonb_has_creator_platform_secret(jsonb), marketplace.jsonb_has_forbidden_public_key(jsonb, text[]),
  marketplace.jsonb_has_marketplace_private_key(jsonb), marketplace.jsonb_is_creator_platform_unavailable_fields(jsonb),
  marketplace.prevent_matching_attribution_mutation(), marketplace.queue_creator_platform_credential_cleanup(),
  marketplace.reject_communication_preference_truncate(), marketplace.require_communication_preference_value_change(),
  marketplace.require_current_matching_outcome_projection(), marketplace.validate_current_matching_outcome_projection(),
  platform.protect_production_marketplace_migration_quarantine();

-- Without CASCADE: anything left in the schema (an object made outside the migrations) fails the
-- migration. The schema's default-privilege entries depend on it automatically and go with it.
DROP SCHEMA marketplace;

ALTER TABLE platform.domain_events DROP CONSTRAINT chk_platform_matching_event_private_payload;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'marketplace') THEN
    RAISE EXCEPTION 'The marketplace schema remains';
  END IF;
  -- Indexes are not checked, as in 0498; the staged legacy copies keep their source names.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname LIKE '%marketplace%' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'migration\_source\_%'
  ) THEN
    RAISE EXCEPTION 'Marketplace relations remain';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'migration_source_marketplace') THEN
    RAISE EXCEPTION 'The staged legacy Marketplace copies must stay';
  END IF;
END $$;
