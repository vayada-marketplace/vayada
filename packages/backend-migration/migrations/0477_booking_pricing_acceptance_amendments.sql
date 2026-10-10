-- VAY-2110: a confirmed pricing-v2 stay can change its dates. The acceptance stays immutable;
-- each date change appends an amendment with the repriced stored quote and its inventory bundle.
-- Only the dates and prices may change: rooms, offers, room types, guests, meal plans, payment
-- method, acceptance mode and currency stay as accepted. PMS adoption then checks the booking
-- against the latest amendment; with no amendment the adoption guard below is 0312's, unchanged.

CREATE TABLE booking.pricing_acceptance_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acceptance_id UUID NOT NULL REFERENCES booking.pricing_quote_acceptances(id),
  property_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  edit_revision INTEGER NOT NULL CHECK (edit_revision >= 1),
  pricing_quote_id UUID NOT NULL UNIQUE,
  quote_snapshot JSONB NOT NULL CHECK (jsonb_typeof(quote_snapshot)='object'),
  inventory_reservation_bundle JSONB NOT NULL CHECK (jsonb_typeof(inventory_reservation_bundle)='object'),
  source TEXT NOT NULL CHECK (source IN ('host_edit','guest_change_request')),
  source_id UUID NOT NULL,
  amended_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (acceptance_id, revision),
  UNIQUE (guest_booking_id, edit_revision),
  FOREIGN KEY (pricing_quote_id, property_id, organization_id)
    REFERENCES booking.pricing_quotes(id, property_id, organization_id),
  FOREIGN KEY (guest_booking_id, property_id) REFERENCES booking.guest_bookings(id, property_id),
  CHECK ((quote_snapshot->>'version'='stored-pricing-quote.v1'
    AND quote_snapshot->>'quoteId'=pricing_quote_id::text
    AND quote_snapshot#>>'{stay,propertyId}'=property_id::text) IS TRUE),
  CHECK ((inventory_reservation_bundle->>'contractVersion'='pms-inventory-reservation-bundle.v1'
    AND inventory_reservation_bundle->>'owner'='pms'
    AND jsonb_typeof(inventory_reservation_bundle->'receipts')='array'
    AND jsonb_array_length(inventory_reservation_bundle->'receipts')>0) IS TRUE)
);

-- What the guest booked besides dates and prices: each room as the PMS adoption guard binds it,
-- each room's meal plan, and the payment method, acceptance mode and currency.
CREATE FUNCTION booking.pricing_acceptance_room_identity(quote JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'currency', quote#>'{stay,currency}',
    'paymentMethod', quote->'paymentMethod',
    'acceptanceMode', quote->'acceptanceMode',
    'rooms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'selectionId', room->'selectionId', 'offerId', room->'offerId',
          'roomTypeId', room->'roomTypeId', 'guests', room->'guests',
          'mealPlan', (SELECT priced->'mealPlan'
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(quote->'rooms')='array'
              THEN quote->'rooms' ELSE '[]'::jsonb END) AS priced_room(priced)
            WHERE priced->'selectionId'=room->'selectionId' LIMIT 1)) ORDER BY position)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(quote#>'{stay,rooms}')='array'
        THEN quote#>'{stay,rooms}' ELSE '[]'::jsonb END) WITH ORDINALITY AS selected(room, position)
    ), '[]'::jsonb))
$$;

CREATE FUNCTION booking.require_pricing_acceptance_amendment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  accepted RECORD;
  previous RECORD;
BEGIN
  -- Same order as PMS adoption and its worker: the property's inventory lock first, before the
  -- foreign keys lock the acceptance; it also serializes the revision read below.
  PERFORM pg_advisory_xact_lock(hashtextextended('pms-inventory:' || NEW.property_id::text, 0));
  SELECT acceptance.* INTO accepted FROM booking.pricing_quote_acceptances acceptance
  WHERE acceptance.id=NEW.acceptance_id;
  IF NOT FOUND OR accepted.property_id<>NEW.property_id
    OR accepted.organization_id<>NEW.organization_id
    OR accepted.guest_booking_id<>NEW.guest_booking_id THEN
    RAISE EXCEPTION 'Amendment must belong to its acceptance''s booking' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM booking.guest_bookings booking
    WHERE booking.id=NEW.guest_booking_id AND booking.property_id=NEW.property_id
      AND booking.lifecycle_status='confirmed') THEN
    RAISE EXCEPTION 'Only a confirmed booking can change its dates' USING ERRCODE='23514';
  END IF;
  SELECT amendment.revision, amendment.edit_revision INTO previous
  FROM booking.pricing_acceptance_amendments amendment
  WHERE amendment.acceptance_id=NEW.acceptance_id
  ORDER BY amendment.revision DESC
  LIMIT 1;
  IF NEW.revision<>COALESCE(previous.revision, 0)+1
    OR NEW.edit_revision<=COALESCE(previous.edit_revision, 0) THEN
    RAISE EXCEPTION 'Amendment revisions must follow each other' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM booking.pricing_quotes q
    WHERE q.id=NEW.pricing_quote_id AND q.property_id=NEW.property_id
      AND q.organization_id=NEW.organization_id AND q.payload->'quote'=NEW.quote_snapshot)
    OR EXISTS (SELECT 1 FROM booking.pricing_quote_acceptances other
      WHERE other.pricing_quote_id=NEW.pricing_quote_id) THEN
    RAISE EXCEPTION 'Amendment must preserve a new exact stored pricing quote' USING ERRCODE='23514';
  END IF;
  IF booking.pricing_acceptance_room_identity(NEW.quote_snapshot)
    IS DISTINCT FROM booking.pricing_acceptance_room_identity(accepted.quote_snapshot) THEN
    RAISE EXCEPTION 'Amendment may change only the stay dates and prices' USING ERRCODE='23514';
  END IF;
  -- The holds are the property's, reserved for this quote and its dates.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.inventory_reservation_bundle->'receipts') AS held(receipt)
    LEFT JOIN pms.inventory_reservation_receipts r
      ON r.receipt_id::text=held.receipt->>'receiptId' AND r.property_id=NEW.property_id
        AND r.organization_id=NEW.organization_id
        AND r.quote_session_id=NEW.pricing_quote_id::text
        AND r.check_in::text=NEW.quote_snapshot#>>'{stay,checkIn}'
        AND r.check_out::text=NEW.quote_snapshot#>>'{stay,checkOut}'
    WHERE r.receipt_id IS NULL) THEN
    RAISE EXCEPTION 'Amendment holds must be reserved for its quote' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pricing_acceptance_amendment_quote
  BEFORE INSERT ON booking.pricing_acceptance_amendments
  FOR EACH ROW EXECUTE FUNCTION booking.require_pricing_acceptance_amendment();
CREATE TRIGGER pricing_acceptance_amendments_immutable
  BEFORE UPDATE OR DELETE ON booking.pricing_acceptance_amendments
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_acceptance_amendments_no_truncate
  BEFORE TRUNCATE ON booking.pricing_acceptance_amendments
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

-- The adoption guard below reads this table on every direct-booking assignment write and runs
-- as the writing role. Grant the API login explicitly so this does not depend on the schema's
-- default privileges (VAY-2054 posture), the same DML a product table gets from them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='vayada_next_api_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON booking.pricing_acceptance_amendments TO vayada_next_api_runtime;
  END IF;
END;
$$;

-- 0312's adoption guard with two changes, both marked VAY-2110: the accepted values come from
-- the latest amendment when there is one, and the booking's edit revision must be that
-- amendment's (0 without one, as before).
CREATE OR REPLACE FUNCTION pms.adopt_direct_booking_inventory_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  booking_receipt_text TEXT;
  booking_row RECORD;
  is_bundle BOOLEAN := FALSE;
  accepted RECORD;
  is_replacement BOOLEAN;
  inventory_quote TEXT;
  explicit_receipt_text TEXT;
  target_receipt_id UUID;
  assignment_row RECORD;
  receipt_row RECORD;
  assignment_count INTEGER;
  assignments_match BOOLEAN;
  target_assignment_id UUID; target_changed_at TIMESTAMPTZ; released_receipt_blocks INTEGER;
BEGIN
  SELECT current_assignment.* INTO assignment_row
  FROM pms.operational_booking_assignments current_assignment
  WHERE current_assignment.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF assignment_row.source <> 'direct_booking'
    OR assignment_row.stay_evidence_kind <> 'exact'
    OR assignment_row.assignment_status IN ('canceled', 'released')
  THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pms-inventory:' || assignment_row.property_id::text, 0));

  SELECT booking.booking_metadata #>> '{inventoryReservation,receiptId}'
    INTO booking_receipt_text
  FROM booking.guest_bookings booking
  WHERE booking.id = assignment_row.guest_booking_id
    AND booking.property_id = assignment_row.property_id
    AND booking.booking_metadata #>> '{inventoryReservation,contractVersion}' =
      'pms-inventory-reservation-lifecycle.v1'
    AND booking.booking_metadata #>> '{inventoryReservation,owner}' = 'pms';
  explicit_receipt_text :=
    assignment_row.assignment_payload #>> '{inventoryReservation,receiptId}';
  SELECT booking.* INTO booking_row FROM booking.guest_bookings booking
  WHERE booking.id = assignment_row.guest_booking_id AND booking.property_id = assignment_row.property_id;
  is_bundle := COALESCE(booking_row.booking_metadata #>> '{inventoryReservation,contractVersion}' =
    'pms-inventory-reservation-bundle.v1', FALSE);
  -- VAY-2110: the latest date-change amendment, when one exists, supplies the stay's current
  -- quote, inventory bundle and edit revision; without one every value is the acceptance's own.
  SELECT acceptance.id, acceptance.organization_id, acceptance.property_id,
    COALESCE(amendment.pricing_quote_id, acceptance.pricing_quote_id) AS pricing_quote_id,
    COALESCE(amendment.inventory_reservation_bundle, acceptance.inventory_reservation_bundle)
      AS inventory_reservation_bundle,
    COALESCE(amendment.quote_snapshot, acceptance.quote_snapshot) AS quote_snapshot,
    COALESCE(amendment.edit_revision, 0) AS edit_revision
  INTO accepted
  FROM booking.pricing_quote_acceptances acceptance
  LEFT JOIN LATERAL (
    SELECT latest.pricing_quote_id, latest.inventory_reservation_bundle, latest.quote_snapshot,
      latest.edit_revision
    FROM booking.pricing_acceptance_amendments latest
    WHERE latest.acceptance_id=acceptance.id
    ORDER BY latest.revision DESC
    LIMIT 1
  ) amendment ON TRUE
  WHERE acceptance.guest_booking_id=booking_row.id AND acceptance.property_id=booking_row.property_id;
  is_replacement := FOUND OR booking_row.booking_metadata->>'targetSource'='pricing_quote_draft'
    OR booking_row.booking_metadata ? 'pricingQuoteId';
  IF is_replacement THEN
    IF accepted.id IS NULL OR NOT (is_bundle
      AND booking_row.quote_session_id IS NULL
      AND booking_row.edit_revision=accepted.edit_revision
      AND booking_row.booking_metadata->>'pricingQuoteId'=accepted.pricing_quote_id::text
      AND booking_row.booking_metadata->'inventoryReservation'=accepted.inventory_reservation_bundle
      AND booking_row.booking_metadata->'pricingSelections'=accepted.quote_snapshot#>'{stay,rooms}'
      AND booking_row.check_in::text=accepted.quote_snapshot#>>'{stay,checkIn}'
      AND booking_row.check_out::text=accepted.quote_snapshot#>>'{stay,checkOut}'
      AND jsonb_typeof(accepted.quote_snapshot#>'{stay,rooms}')='array'
      AND booking_row.room_count=jsonb_array_length(accepted.quote_snapshot#>'{stay,rooms}')) IS TRUE
    THEN
      RAISE EXCEPTION 'replacement inventory has no matching unchanged acceptance' USING ERRCODE='23514',
        CONSTRAINT='chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
    inventory_quote := accepted.pricing_quote_id::text;
    -- A deferred invocation sees all physical selections, including same-type rooms.
    -- Receipt organization and original type stay authoritative after a PMS room move.
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(accepted.quote_snapshot#>'{stay,rooms}')
        WITH ORDINALITY selected(room, position)
      LEFT JOIN pms.operational_booking_assignments a
        ON a.guest_booking_id=booking_row.id AND a.property_id=booking_row.property_id
          AND a.position=selected.position
      LEFT JOIN pms.inventory_reservation_receipts r
        ON r.receipt_id::text=a.assignment_payload#>>'{inventoryReservation,receiptId}'
      LEFT JOIN pms.inventory_reservation_statuses status USING(receipt_id)
      HAVING count(*)=booking_row.room_count
        AND count(DISTINCT room->>'selectionId')=booking_row.room_count
        AND sum((room#>>'{guests,adults}')::integer)=booking_row.adults
        AND sum(jsonb_array_length(room#>'{guests,childAgesAtCheckIn}'))=booking_row.children
        AND bool_and(COALESCE(
          a.source='direct_booking' AND a.stay_evidence_kind='exact'
          AND a.assignment_status NOT IN ('canceled','released')
          AND a.adults=(room#>>'{guests,adults}')::integer
          AND a.children=jsonb_array_length(room#>'{guests,childAgesAtCheckIn}')
          AND a.assignment_payload->'pricingAcceptance'=jsonb_build_object(
            'acceptanceId',accepted.id::text,'selectionId',room->>'selectionId',
            'offerId',room->>'offerId','childAgesAtCheckIn',room#>'{guests,childAgesAtCheckIn}')
          AND r.organization_id=accepted.organization_id AND r.property_id=accepted.property_id
          AND r.quote_session_id=inventory_quote AND r.room_type_id::text=room->>'roomTypeId'
          AND (status.lifecycle_state='handed_off' OR
            (status.lifecycle_state='reserved' AND a.room_type_id=r.room_type_id
              AND booking_row.lifecycle_status='confirmed'))
        ,FALSE))
    ) THEN
      RAISE EXCEPTION 'replacement assignments do not match accepted selections' USING ERRCODE='23514',
        CONSTRAINT='chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
  END IF;
  IF is_bundle THEN
    IF NOT COALESCE(is_replacement,FALSE) THEN
    inventory_quote := COALESCE(booking_row.booking_metadata->>'inventoryQuoteSessionId', booking_row.quote_session_id::text);
    IF inventory_quote IS DISTINCT FROM booking_row.quote_session_id::text AND NOT (
      EXISTS (SELECT 1 FROM booking.booking_change_requests change_request
        WHERE change_request.guest_booking_id=booking_row.id AND change_request.status='accepted'
          AND inventory_quote='change-request:' || change_request.id::text
          AND change_request.id::text=booking_row.booking_metadata->>'lastAcceptedChangeRequestId'
          AND change_request.requested_changes->>'requestedCheckIn'=booking_row.check_in::text
          AND change_request.requested_changes->>'requestedCheckOut'=booking_row.check_out::text
          AND change_request.requested_changes#>'{pricingSnapshot,selectedOffer,roomSelection}'=
            booking_row.booking_metadata#>'{selectedOffer,roomSelection}')
      OR EXISTS (SELECT 1 FROM booking.host_action_previews preview
        JOIN booking.booking_status_events event ON event.guest_booking_id=preview.guest_booking_id
          AND event.event_type='guest_booking.host_dates_updated'
          AND event.event_payload->>'changeRequestId'=preview.id::text
          AND event.actor_user_id=preview.actor_user_id
          AND event.occurred_at >= preview.created_at AND event.occurred_at < preview.expires_at
        WHERE preview.property_id=booking_row.property_id AND preview.guest_booking_id=booking_row.id
          AND inventory_quote='host-edit:' || preview.id::text AND preview.action='edit_dates'
          AND preview.id::text=booking_row.booking_metadata->>'lastHostEditPreviewId'
          AND preview.request->>'checkIn'=booking_row.check_in::text
          AND preview.request->>'checkOut'=booking_row.check_out::text)
    ) THEN
      RAISE EXCEPTION 'inventory bundle has no matching date-change decision' USING ERRCODE='23514',
        CONSTRAINT='chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
    END IF; -- legacy quote / accepted amendment correlation
    IF booking_row.booking_metadata #>> '{inventoryReservation,owner}' IS DISTINCT FROM 'pms'
      OR jsonb_typeof(booking_row.booking_metadata #> '{inventoryReservation,receipts}') IS DISTINCT FROM 'array'
    THEN
      RAISE EXCEPTION 'invalid inventory receipt bundle' USING ERRCODE = '23514',
        CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
    -- Deferred check sees the final assignment set: every receipt must have all its rooms.
    IF NOT EXISTS (
      WITH tokens AS (
        SELECT token FROM jsonb_array_elements(booking_row.booking_metadata #> '{inventoryReservation,receipts}') token
      ), expected AS (
        SELECT receipt.*, status.lifecycle_state, token
        FROM tokens JOIN pms.inventory_reservation_receipts receipt ON receipt.receipt_id::text = token->>'receiptId'
        JOIN pms.inventory_reservation_statuses status USING(receipt_id)
        WHERE receipt.property_id=assignment_row.property_id
          AND receipt.quote_session_id=inventory_quote
          AND receipt.check_in=booking_row.check_in AND receipt.check_out=booking_row.check_out
      )
      SELECT 1 FROM expected
      HAVING count(*) BETWEEN 1 AND 99
        AND count(*)=(SELECT count(*) FROM tokens)
        AND count(*)=count(DISTINCT receipt_id)
        AND count(*)=count(DISTINCT room_type_id)
        AND count(*)=(SELECT count(*) FROM pms.inventory_reservation_receipts r
          WHERE r.property_id=assignment_row.property_id AND r.quote_session_id=inventory_quote)
        AND sum(room_count)=booking_row.room_count
        AND sum(room_count)=(SELECT count(*) FROM pms.operational_booking_assignments a
          WHERE a.property_id=assignment_row.property_id AND a.guest_booking_id=assignment_row.guest_booking_id
            AND a.source='direct_booking' AND a.stay_evidence_kind='exact' AND a.assignment_status NOT IN ('canceled','released'))
        AND bool_and(token->>'contractVersion'='pms-inventory-reservation-lifecycle.v1' AND token->>'owner'='pms'
          AND lifecycle_state IN ('reserved','handed_off')
          AND room_count=(SELECT count(*) FROM pms.operational_booking_assignments a
            WHERE a.property_id=assignment_row.property_id AND a.guest_booking_id=assignment_row.guest_booking_id
              AND a.source='direct_booking' AND a.stay_evidence_kind='exact' AND a.assignment_status NOT IN ('canceled','released')
              AND a.assignment_payload->'inventoryReservation'=expected.token
              AND a.check_in=expected.check_in AND a.check_out=expected.check_out
              AND (expected.lifecycle_state='handed_off' OR a.room_type_id=expected.room_type_id)))
    ) THEN
      RAISE EXCEPTION 'assignments do not match the complete inventory receipt bundle' USING ERRCODE = '23514',
        CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
    SELECT token->>'receiptId' INTO booking_receipt_text
    FROM jsonb_array_elements(booking_row.booking_metadata #> '{inventoryReservation,receipts}') token
    WHERE token->>'receiptId'=explicit_receipt_text;
    IF booking_receipt_text IS NULL THEN
      RAISE EXCEPTION 'assignment requires a receipt from its booking bundle' USING ERRCODE = '23514',
        CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND explicit_receipt_text IS NULL THEN IF OLD.assignment_payload #>> '{inventoryReservation,receiptId}' IS NOT NULL THEN RAISE EXCEPTION 'direct booking assignment receipt cannot be removed' USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope'; END IF; RETURN NULL; END IF;

  IF booking_receipt_text IS NULL AND explicit_receipt_text IS NULL THEN
    RETURN NULL;
  END IF;
  IF explicit_receipt_text IS NOT NULL AND (
    assignment_row.assignment_payload #>> '{inventoryReservation,contractVersion}'
      IS DISTINCT FROM 'pms-inventory-reservation-lifecycle.v1'
    OR assignment_row.assignment_payload #>> '{inventoryReservation,owner}' IS DISTINCT FROM 'pms'
  ) THEN
    RAISE EXCEPTION 'direct booking assignment receipt is not a PMS receipt'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;
  IF COALESCE(explicit_receipt_text, booking_receipt_text) !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'direct booking inventory receipt identifier is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;
  target_receipt_id := COALESCE(explicit_receipt_text, booking_receipt_text)::uuid;

  SELECT receipt.property_id, receipt.room_type_id, receipt.check_in, receipt.check_out,
         receipt.room_count, status.lifecycle_state, status.lifecycle_revision
    INTO receipt_row
  FROM pms.inventory_reservation_receipts receipt
  JOIN pms.inventory_reservation_statuses status USING (receipt_id)
  WHERE receipt.receipt_id = target_receipt_id
    AND receipt.property_id = assignment_row.property_id
  FOR UPDATE OF status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'direct booking inventory receipt was not found for this property'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;

  IF receipt_row.lifecycle_state = 'handed_off'
    AND receipt_row.lifecycle_revision = 2
  THEN
    IF explicit_receipt_text IS NOT NULL
      AND lower(booking_receipt_text) IS DISTINCT FROM lower(explicit_receipt_text)
    THEN
      RAISE EXCEPTION 'direct booking receipt tokens do not match'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
  ELSIF receipt_row.lifecycle_state <> 'reserved'
    OR receipt_row.lifecycle_revision <> 1
  THEN
    RAISE EXCEPTION 'direct booking inventory receipt is not reserved'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_state';
  END IF;
  IF receipt_row.lifecycle_state = 'reserved' AND (
    explicit_receipt_text IS NULL
    OR lower(booking_receipt_text) IS DISTINCT FROM lower(explicit_receipt_text)
  ) THEN
    RAISE EXCEPTION 'reserved direct booking receipt requires matching explicit tokens'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;

  SELECT count(*)::integer,
         bool_and(COALESCE(
           (receipt_row.lifecycle_state = 'handed_off'
             OR assignment.room_type_id = receipt_row.room_type_id)
           AND assignment.check_in = receipt_row.check_in
           AND assignment.check_out = receipt_row.check_out
           AND assignment.assignment_payload #>> '{inventoryReservation,contractVersion}' =
             'pms-inventory-reservation-lifecycle.v1'
           AND assignment.assignment_payload #>> '{inventoryReservation,owner}' = 'pms'
           AND assignment.assignment_payload #>> '{inventoryReservation,receiptId}' =
             target_receipt_id::text
         , FALSE)),
         (array_agg(assignment.id ORDER BY assignment.position, assignment.id))[1]
    INTO assignment_count, assignments_match, target_assignment_id
  FROM pms.operational_booking_assignments assignment
  WHERE assignment.guest_booking_id = assignment_row.guest_booking_id
    AND assignment.property_id = assignment_row.property_id
    AND assignment.source = 'direct_booking'
    AND assignment.stay_evidence_kind = 'exact'
    AND assignment.assignment_status NOT IN ('canceled', 'released')
    AND (NOT is_bundle OR assignment.assignment_payload #>> '{inventoryReservation,receiptId}' = target_receipt_id::text);
  IF assignment_count <> receipt_row.room_count OR assignments_match IS NOT TRUE THEN
    RAISE EXCEPTION 'direct booking assignments do not match the inventory receipt'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;
  IF receipt_row.lifecycle_state = 'handed_off' THEN
    RETURN NULL;
  END IF;

  target_changed_at := CASE WHEN TG_OP = 'UPDATE'
    THEN assignment_row.updated_at
    ELSE COALESCE(assignment_row.assigned_at, assignment_row.created_at) END;
  UPDATE pms.inventory_reservation_statuses
  SET lifecycle_state = 'handed_off', lifecycle_revision = 2,
      handed_off_at = target_changed_at
  WHERE receipt_id = target_receipt_id
    AND property_id = assignment_row.property_id
    AND lifecycle_state = 'reserved'
    AND lifecycle_revision = 1;

  UPDATE pms.room_blocks receipt_block
  SET status = 'released', released_at = target_changed_at,
      updated_at = target_changed_at
  WHERE receipt_block.property_id = assignment_row.property_id
    AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
    AND receipt_block.status = 'active'
    AND EXISTS (
      SELECT 1 FROM pms.room_blocks assignment_block
      WHERE assignment_block.property_id = receipt_block.property_id
        AND assignment_block.source_assignment_id = target_assignment_id
        AND assignment_block.room_type_id = receipt_block.room_type_id
    );
  GET DIAGNOSTICS released_receipt_blocks = ROW_COUNT;
  UPDATE pms.room_blocks receipt_block
  SET source_inventory_reservation_receipt_id = NULL,
      source_assignment_id = target_assignment_id,
      updated_at = target_changed_at
  WHERE receipt_block.property_id = assignment_row.property_id
    AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
    AND receipt_block.status = 'active';
  IF released_receipt_blocks > 0 THEN
    WITH desired AS (
      SELECT inventory.room_type_id, inventory.stay_date,
        LEAST(COALESCE(sum(active.blocked_count), 0),
          GREATEST(inventory.total_count - inventory.assigned_count, 0))::integer blocked_count
      FROM pms.inventory_days inventory
      JOIN pms.room_blocks receipt_block
        ON receipt_block.property_id = inventory.property_id AND receipt_block.room_type_id = inventory.room_type_id
       AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
       AND inventory.stay_date BETWEEN receipt_block.starts_on AND receipt_block.ends_on
      LEFT JOIN pms.room_blocks active
        ON active.property_id = inventory.property_id AND active.room_type_id = inventory.room_type_id
       AND active.status = 'active'
       AND inventory.stay_date BETWEEN active.starts_on AND active.ends_on
      WHERE inventory.property_id = assignment_row.property_id
      GROUP BY inventory.room_type_id, inventory.stay_date, inventory.total_count, inventory.assigned_count
    )
    UPDATE pms.inventory_days inventory
    SET blocked_count = desired.blocked_count,
        available_count = CASE WHEN inventory.status = 'closed' OR inventory.linked_stop_sell THEN 0
          ELSE GREATEST(0, inventory.effective_sellable_limit_count - inventory.assigned_count
            - desired.blocked_count) END,
        inventory_revision = inventory.inventory_revision + 1,
        block_source_revision = inventory.block_source_revision + 1,
        updated_at = target_changed_at
    FROM desired
    WHERE inventory.property_id = assignment_row.property_id
      AND inventory.room_type_id = desired.room_type_id
      AND inventory.stay_date = desired.stay_date
      AND inventory.blocked_count IS DISTINCT FROM desired.blocked_count;
  END IF;
  RETURN NULL;
END;
$$;
