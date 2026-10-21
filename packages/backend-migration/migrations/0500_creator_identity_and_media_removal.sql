-- Migration: 0500_creator_identity_and_media_removal
-- Owner: platform / VAY-2272 (Marketplace removal step 5, M-E, window W3). Held by hand: merged
-- with Flamur's yes, after the counts-0500 before-runs, with PR 7 live, the WorkOS clean-up done and
-- the PR 9 purge finished (MD06 = 0).
--
-- Removes the creator and affiliate side of identity: creator workspaces and affiliate partners, the
-- users who only belonged to them or were created as creators or affiliates (decision 4), their
-- memberships, links, entitlements, consents and GDPR requests, payout settings and provider
-- accounts no kept record uses (decision 7), the Marketplace finance visibility rows, and the media
-- whose files the purge already deleted (decision 5). An account that kept rows still name is closed
-- with blank details instead of deleted (decision 3): finance payees keep only their name and slug,
-- and anything WorkOS knows keeps a blank row, so a late WorkOS message lands there instead of
-- creating a new account. The staged legacy copies (migration_source_*) are not touched (decision 8);
-- 0498 already dropped the affiliate money records (decision 2: delete everything).
-- Rollback: any image that has PR 7 (older ones let WorkOS updates rewrite closed accounts). Deleted
-- rows and purged files do not come back.

SET LOCAL lock_timeout = '5s';
-- next-api runs migrations before it serves, so a slow run fails here with a clear error first.
SET LOCAL statement_timeout = '120s';
-- Nobody joins, leaves or files a GDPR request while the sets below are in use; reads go on.
LOCK TABLE identity.organization_memberships, identity.gdpr_requests IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMPORARY TABLE removed_organizations ON COMMIT DROP AS
  SELECT id, workos_org_id FROM identity.organizations WHERE kind IN ('creator_workspace', 'affiliate_partner');
-- Creator-only users, plus users created as type creator or affiliate (decision 4); never a user with
-- a membership anywhere else.
CREATE TEMPORARY TABLE removed_users ON COMMIT DROP AS
  SELECT u.id FROM identity.users u
  WHERE (EXISTS (SELECT 1 FROM identity.organization_memberships m
                 WHERE m.user_id = u.id AND m.organization_id IN (SELECT id FROM removed_organizations))
         OR EXISTS (SELECT 1 FROM identity.auth_reconciliation_events e
                    WHERE e.user_id = u.id AND e.event_type = 'identity.user.created'
                      AND e.payload -> 'payload' ->> 'legacyUserType' IN ('creator', 'affiliate')))
    AND NOT EXISTS (SELECT 1 FROM identity.organization_memberships other
                    WHERE other.user_id = u.id AND other.organization_id NOT IN (SELECT id FROM removed_organizations));
CREATE TEMPORARY TABLE removed_media ON COMMIT DROP AS
  SELECT id, storage_kind, source_metadata FROM platform.media_objects
  WHERE purpose LIKE 'marketplace.%' OR owner_organization_id IN (SELECT id FROM removed_organizations)
     OR created_by_user_id IN (SELECT id FROM removed_users);

-- Gates: stop before anything changes.
DO $$
BEGIN
  -- The purge leaves these for a person; the foreign keys would fail or set a logo to NULL without a
  -- word. Same list as the purge's kept references.
  IF EXISTS (SELECT 1 FROM removed_media media
             WHERE EXISTS (SELECT 1 FROM hotel_catalog.property_media ref WHERE ref.platform_media_object_id = media.id)
                OR EXISTS (SELECT 1 FROM pms.room_type_media ref WHERE ref.platform_media_object_id = media.id)
                OR EXISTS (SELECT 1 FROM pms.message_attachments ref WHERE ref.platform_media_object_id = media.id)
                OR EXISTS (SELECT 1 FROM finance.expenses ref WHERE ref.receipt_media_id = media.id)
                OR EXISTS (SELECT 1 FROM booking.booking_settings ref WHERE ref.header_logo_media_object_id = media.id)
                OR EXISTS (SELECT 1 FROM booking.addon_definitions ref
                           WHERE ref.metadata ->> 'mediaObjectId' = media.id::text
                              OR (jsonb_typeof(ref.metadata -> 'photos') = 'array'
                                  AND ref.metadata -> 'photos' @> jsonb_build_array(
                                    jsonb_build_object('mediaObjectId', media.id::text))))
                OR EXISTS (SELECT 1 FROM identity.users kept
                           WHERE lower(kept.profile_picture_media_object_id) = media.id::text
                             AND kept.id NOT IN (SELECT id FROM removed_users))) THEN
    RAISE EXCEPTION 'Hotel data or a kept user still uses creator media';
  END IF;
  IF EXISTS (SELECT 1 FROM removed_media WHERE storage_kind = 'vayada_managed'
             AND NULLIF(source_metadata ->> 'retiredPurgeCompletedAt', '') IS NULL) THEN
    RAISE EXCEPTION 'Creator media stored by Vayada without the purge marker';
  END IF;
  -- The rollback cleanup finds its copies through these rows; without them the copies would stay.
  IF EXISTS (SELECT 1 FROM removed_media WHERE NULLIF(source_metadata ->> 'rollbackStorageKey', '') IS NOT NULL
             AND COALESCE(source_metadata ->> 'rollbackCleanupStatus', '') <> 'completed') THEN
    RAISE EXCEPTION 'Creator media with a rollback copy still stored';
  END IF;
  IF EXISTS (SELECT 1 FROM platform.media_upload_sessions s
             WHERE s.session_status IN ('requested', 'signed', 'uploaded', 'finalizing') AND s.expires_at > now()
               AND (s.requested_purpose LIKE 'marketplace.%'
                    OR s.owner_organization_id IN (SELECT id FROM removed_organizations)
                    OR s.actor_user_id IN (SELECT id FROM removed_users))) THEN
    RAISE EXCEPTION 'Creator uploads still in flight';
  END IF;
  -- Decision 7: open requests are finished through the normal process first.
  IF EXISTS (SELECT 1 FROM identity.gdpr_requests g
             WHERE g.user_id IN (SELECT id FROM removed_users) AND g.status IN ('pending', 'processing')) THEN
    RAISE EXCEPTION 'Open GDPR requests of creator users';
  END IF;
  -- The foreign key would unassign the thread without a word.
  IF EXISTS (SELECT 1 FROM pms.message_threads t
             JOIN identity.organization_memberships m ON m.id = t.assigned_to_membership_id
             WHERE m.organization_id IN (SELECT id FROM removed_organizations)) THEN
    RAISE EXCEPTION 'A PMS thread is assigned to a creator membership';
  END IF;
  -- Deleting the memberships would fail on these or take them along without a word.
  IF EXISTS (SELECT 1 FROM identity.staff_invitations i WHERE i.organization_id IN (SELECT id FROM removed_organizations))
     OR EXISTS (SELECT 1 FROM identity.membership_delegations d
                WHERE d.organization_id IN (SELECT id FROM removed_organizations))
     OR EXISTS (SELECT 1 FROM identity.account_admin_transfer_proofs p
                JOIN identity.organization_memberships m ON m.id IN (p.actor_membership_id, p.target_membership_id)
                WHERE p.organization_id IN (SELECT id FROM removed_organizations)
                   OR m.organization_id IN (SELECT id FROM removed_organizations)) THEN
    RAISE EXCEPTION 'Staff invitations, delegations or admin transfers in a creator workspace';
  END IF;
  IF EXISTS (SELECT 1 FROM pms.inbox_email_routes r
             JOIN identity.organization_memberships m ON m.id = r.approved_by_membership_id
             WHERE m.organization_id IN (SELECT id FROM removed_organizations)) THEN
    RAISE EXCEPTION 'A PMS inbox route was approved by a creator membership';
  END IF;
  -- The legacy catalog import reads this link as the hotel's ownership.
  IF EXISTS (SELECT 1 FROM hotel_catalog.properties p
             WHERE EXISTS (SELECT 1 FROM identity.organization_resource_links ml
                           WHERE ml.product = 'marketplace' AND ml.resource_type = 'hotel_profile'
                             AND ml.relationship = 'owner' AND ml.status = 'active' AND ml.resource_id = p.id::text)
               AND NOT EXISTS (SELECT 1 FROM identity.organization_resource_links ol
                               WHERE ol.product <> 'marketplace' AND ol.relationship IN ('owner', 'operator')
                                 AND ol.status = 'active' AND ol.resource_id = p.id::text)) THEN
    RAISE EXCEPTION 'A hotel is owned only through its Marketplace link';
  END IF;
END $$;

-- Queue rows of a product without handlers.
UPDATE platform.jobs SET status = 'canceled', finished_at = now(), updated_at = now()
  WHERE resource_product = 'marketplace' AND status = 'pending';
UPDATE platform.outbox_events SET status = 'canceled', updated_at = now()
  WHERE resource_product = 'marketplace' AND status IN ('pending', 'failed');

-- Read model, links and entitlements of the retired products.
DELETE FROM finance.finance_visibility_read_model
  WHERE visibility_scope = 'affiliate_payout' OR resource_type IN ('affiliate', 'marketplace')
     OR required_permission_key IN ('affiliate.payout.manage', 'marketplace.finance.read')
     OR organization_id IN (SELECT id FROM removed_organizations);
DELETE FROM identity.organization_resource_links
  WHERE product IN ('marketplace', 'affiliate')
     OR resource_type IN ('hotel_profile', 'marketplace_offer', 'creator_profile', 'affiliate')
     OR relationship = 'promotes' OR organization_id IN (SELECT id FROM removed_organizations);
DELETE FROM identity.product_entitlements
  WHERE product IN ('marketplace', 'affiliate') OR resource_product IN ('marketplace', 'affiliate')
     OR resource_type IN ('hotel_profile', 'marketplace_offer', 'creator_profile', 'affiliate')
     OR organization_id IN (SELECT id FROM removed_organizations);

-- Memberships (their property assignments cascade), then personal data (decision 7: GDPR requests
-- go with the account).
DELETE FROM identity.organization_memberships WHERE organization_id IN (SELECT id FROM removed_organizations);
DELETE FROM identity.user_consent_status WHERE user_id IN (SELECT id FROM removed_users);
DELETE FROM identity.consent_history WHERE user_id IN (SELECT id FROM removed_users);
DELETE FROM identity.cookie_consents WHERE user_id IN (SELECT id FROM removed_users);
DELETE FROM identity.gdpr_requests WHERE user_id IN (SELECT id FROM removed_users);
-- WorkOS "already processed" markers stay without who they were about: the webhook treats a
-- redelivered event as a duplicate only while its marker exists. Everything else goes.
UPDATE identity.auth_reconciliation_events SET user_id = NULL, organization_id = NULL, payload = NULL, error = NULL
  WHERE event_type IN ('workos.webhook.normalized', 'workos.webhook.ignored', 'workos.webhook.dead_lettered')
    AND (user_id IN (SELECT id FROM removed_users) OR organization_id IN (SELECT id FROM removed_organizations));
DELETE FROM identity.auth_reconciliation_events
  WHERE user_id IN (SELECT id FROM removed_users) OR organization_id IN (SELECT id FROM removed_organizations);

-- Payout settings and provider accounts no kept record uses (decision 7).
DELETE FROM finance.payout_settings s
  WHERE s.organization_id IN (SELECT id FROM removed_organizations)
    AND NOT EXISTS (SELECT 1 FROM finance.payouts p WHERE p.payout_setting_id = s.id);
DELETE FROM finance.payment_provider_accounts a
  WHERE a.organization_id IN (SELECT id FROM removed_organizations)
    AND NOT EXISTS (SELECT 1 FROM finance.payouts p
                    WHERE p.organization_provider_account_id = a.id OR p.property_provider_account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM finance.payments y WHERE y.provider_account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM finance.payment_settings ps WHERE ps.provider_account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM finance.payout_settings s
                    WHERE s.organization_provider_account_id = a.id OR s.property_provider_account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM finance.online_card_execution_evidence oc WHERE oc.provider_account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM finance.provider_fee_evidence pf WHERE pf.provider_account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM booking.pending_booking_edit_attempts pe WHERE pe.provider_account_id = a.id);

-- Media: the purge already deleted the files of Vayada-stored rows; external references never had a
-- file of ours. Only removed users still point at them; they are blanked or deleted below. Migration
-- items go before the rows they point at.
DELETE FROM platform.production_media_migration_items
  WHERE media_object_id IN (SELECT id FROM removed_media) OR (media_object_id IS NULL AND purpose LIKE 'marketplace.%');
DELETE FROM platform.media_upload_sessions
  WHERE requested_purpose LIKE 'marketplace.%' OR owner_organization_id IN (SELECT id FROM removed_organizations)
     OR actor_user_id IN (SELECT id FROM removed_users) OR completed_media_object_id IN (SELECT id FROM removed_media);
DELETE FROM platform.media_objects WHERE id IN (SELECT id FROM removed_media);

-- Who stays, decided after the deletes above.
-- Payees of records kept by law.
CREATE TEMPORARY TABLE finance_kept_organizations ON COMMIT DROP AS
  SELECT r.id FROM removed_organizations r
  WHERE EXISTS (SELECT 1 FROM finance.payouts p WHERE p.organization_id = r.id)
     OR EXISTS (SELECT 1 FROM finance.payments y WHERE y.organization_id = r.id)
     OR EXISTS (SELECT 1 FROM finance.billing_entitlements b WHERE b.organization_id = r.id)
     OR EXISTS (SELECT 1 FROM finance.commission_rules c WHERE c.organization_id = r.id)
     OR EXISTS (SELECT 1 FROM finance.payout_settings s WHERE s.organization_id = r.id)
     OR EXISTS (SELECT 1 FROM finance.payment_provider_accounts a WHERE a.organization_id = r.id)
     OR EXISTS (SELECT 1 FROM finance.online_card_execution_evidence oc WHERE oc.accepted_by_organization_id = r.id);
CREATE TEMPORARY TABLE tombstone_organizations ON COMMIT DROP AS
  SELECT r.id FROM removed_organizations r
  WHERE r.id NOT IN (SELECT id FROM finance_kept_organizations)
    -- The WorkOS id is unique, so a late WorkOS message lands on this blank row instead of creating
    -- a new organization.
    AND (r.workos_org_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM platform.domain_events d WHERE d.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM platform.product_audit_events a WHERE a.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM platform.outbox_events e WHERE e.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM platform.jobs j WHERE j.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM platform.idempotency_keys k WHERE k.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM platform.dead_letter_events l WHERE l.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM platform.external_webhook_events w WHERE w.organization_id = r.id)
      -- Rows that would otherwise go with the organization without a word.
      OR EXISTS (SELECT 1 FROM hotel_catalog.organization_setup_track_intents i WHERE i.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM hotel_catalog.property_setup_sessions ss WHERE ss.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM identity.account_admin_guards g WHERE g.organization_id = r.id)
      OR EXISTS (SELECT 1 FROM identity.organization_roles ro WHERE ro.organization_id = r.id));
CREATE TEMPORARY TABLE tombstone_users ON COMMIT DROP AS
  SELECT r.id FROM removed_users r
  -- A user WorkOS knows keeps a blank row, so a late WorkOS message cannot create a new account.
  WHERE EXISTS (SELECT 1 FROM identity.external_identities x WHERE x.user_id = r.id AND x.provider_user_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM platform.domain_events d WHERE d.actor_user_id = r.id)
     OR EXISTS (SELECT 1 FROM platform.product_audit_events a WHERE a.actor_user_id = r.id)
     -- Columns that would otherwise be set to NULL without a word.
     OR EXISTS (SELECT 1 FROM finance.commission_rate_changes c WHERE c.changed_by_user_id = r.id)
     OR EXISTS (SELECT 1 FROM pms.booking_notes_private n WHERE n.edited_by_user_id = r.id)
     OR EXISTS (SELECT 1 FROM distribution.external_api_clients x WHERE x.created_by_user_id = r.id OR x.revoked_by_user_id = r.id)
     OR EXISTS (SELECT 1 FROM hotel_catalog.hotel_account_invites h WHERE h.created_by_user_id = r.id OR h.redeemed_by_user_id = r.id);

-- The WorkOS user id stays for the lookup; nothing else about the person does.
UPDATE identity.external_identities
   SET provider_email = NULL, provider_email_verified = false, raw_profile = NULL, last_login_at = NULL,
       updated_at = now()
 WHERE user_id IN (SELECT id FROM tombstone_users);
DELETE FROM identity.external_identities
  WHERE user_id IN (SELECT id FROM removed_users) AND user_id NOT IN (SELECT id FROM tombstone_users);
UPDATE identity.organizations SET status = 'archived', website_url = NULL, updated_at = now()
 WHERE id IN (SELECT id FROM finance_kept_organizations);
UPDATE identity.organizations
   SET status = 'archived', name = 'Removed workspace', slug = 'removed-' || id::text, website_url = NULL,
       updated_at = now()
 WHERE id IN (SELECT id FROM tombstone_organizations);
UPDATE identity.users
   SET status = 'deleted', email = 'removed-' || id::text || '@removed.invalid', name = NULL, phone = NULL,
       profile_picture_url = NULL, profile_picture_media_object_id = NULL, updated_at = now()
 WHERE id IN (SELECT id FROM tombstone_users);

-- The rest is deleted. If something not listed above still names a row, the rows go one by one and
-- that row becomes a blank row instead (23503: a foreign key; 55000: an append-only table).
DO $$
DECLARE target RECORD;
BEGIN
  BEGIN
    DELETE FROM identity.users WHERE id IN (SELECT id FROM removed_users WHERE id NOT IN (SELECT id FROM tombstone_users));
  EXCEPTION WHEN foreign_key_violation OR object_not_in_prerequisite_state THEN
    IF SQLSTATE NOT IN ('23503', '55000') THEN RAISE; END IF;
    FOR target IN SELECT id FROM removed_users WHERE id NOT IN (SELECT id FROM tombstone_users) ORDER BY id LOOP
      BEGIN
        DELETE FROM identity.users WHERE id = target.id;
      EXCEPTION WHEN foreign_key_violation OR object_not_in_prerequisite_state THEN
        IF SQLSTATE NOT IN ('23503', '55000') THEN RAISE; END IF;
        UPDATE identity.users
           SET status = 'deleted', email = 'removed-' || target.id::text || '@removed.invalid', name = NULL,
               phone = NULL, profile_picture_url = NULL, profile_picture_media_object_id = NULL, updated_at = now()
         WHERE id = target.id;
      END;
    END LOOP;
  END;
  BEGIN
    DELETE FROM identity.organizations
     WHERE id IN (SELECT id FROM removed_organizations
                  WHERE id NOT IN (SELECT id FROM tombstone_organizations)
                    AND id NOT IN (SELECT id FROM finance_kept_organizations));
  EXCEPTION WHEN foreign_key_violation OR object_not_in_prerequisite_state THEN
    IF SQLSTATE NOT IN ('23503', '55000') THEN RAISE; END IF;
    FOR target IN SELECT id FROM removed_organizations
                  WHERE id NOT IN (SELECT id FROM tombstone_organizations)
                    AND id NOT IN (SELECT id FROM finance_kept_organizations)
                  ORDER BY id LOOP
      BEGIN
        DELETE FROM identity.organizations WHERE id = target.id;
      EXCEPTION WHEN foreign_key_violation OR object_not_in_prerequisite_state THEN
        IF SQLSTATE NOT IN ('23503', '55000') THEN RAISE; END IF;
        UPDATE identity.organizations
           SET status = 'archived', name = 'Removed workspace', slug = 'removed-' || target.id::text,
               website_url = NULL, updated_at = now()
         WHERE id = target.id;
      END;
    END LOOP;
  END;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity.organization_memberships m
             JOIN identity.organizations o ON o.id = m.organization_id
             WHERE o.kind IN ('creator_workspace', 'affiliate_partner')) THEN
    RAISE EXCEPTION 'A membership in a creator or affiliate organization remains';
  END IF;
  IF EXISTS (SELECT 1 FROM identity.organization_memberships m JOIN removed_users r ON r.id = m.user_id) THEN
    RAISE EXCEPTION 'A removed user still has a membership';
  END IF;
  IF EXISTS (SELECT 1 FROM identity.organizations
             WHERE kind IN ('creator_workspace', 'affiliate_partner') AND status <> 'archived') THEN
    RAISE EXCEPTION 'A creator or affiliate organization is still open';
  END IF;
  IF EXISTS (SELECT 1 FROM identity.users u JOIN removed_users r ON r.id = u.id
             WHERE u.status <> 'deleted' OR u.email <> 'removed-' || u.id::text || '@removed.invalid'
                OR u.name IS NOT NULL OR u.phone IS NOT NULL OR u.profile_picture_url IS NOT NULL
                OR u.profile_picture_media_object_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A removed user keeps their details';
  END IF;
  IF EXISTS (SELECT 1 FROM identity.organization_resource_links WHERE product IN ('marketplace', 'affiliate'))
     OR EXISTS (SELECT 1 FROM identity.product_entitlements
                WHERE product IN ('marketplace', 'affiliate') OR resource_product IN ('marketplace', 'affiliate')) THEN
    RAISE EXCEPTION 'A Marketplace or affiliate link or entitlement remains';
  END IF;
  IF EXISTS (SELECT 1 FROM platform.media_objects
             WHERE purpose LIKE 'marketplace.%' OR id IN (SELECT id FROM removed_media)) THEN
    RAISE EXCEPTION 'Creator or Marketplace media remains';
  END IF;
END $$;
