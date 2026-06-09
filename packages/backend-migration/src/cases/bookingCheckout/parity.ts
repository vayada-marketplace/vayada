import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type BookingFlowCheck = NonNullable<ExpectedTarget["bookingCheckoutChecks"]>["flows"][number];

async function checkBookingFlow(
  client: pg.Client,
  flow: BookingFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    quote_status: string;
    checkout_status: string;
    lifecycle_status: string;
    payment_status: string;
    public_quote_reference: string;
    public_booking_reference: string;
    payment_id: string | null;
    payment_amount: string | null;
    payment_currency: string | null;
    payment_row_status: string | null;
    payment_booking_id: string | null;
    summary_reference: string | null;
    summary_lifecycle_status: string | null;
    summary_payment_status: string | null;
    summary_total: string | null;
    summary_currency: string | null;
  }>(
    `SELECT
       q.status AS quote_status,
       c.status AS checkout_status,
       b.lifecycle_status,
       b.payment_status,
       q.public_quote_reference,
       b.public_reference AS public_booking_reference,
       p.id::text AS payment_id,
       p.amount::text AS payment_amount,
       p.currency AS payment_currency,
       p.status AS payment_row_status,
       p.guest_booking_id::text AS payment_booking_id,
       rm.public_reference AS summary_reference,
       rm.lifecycle_status AS summary_lifecycle_status,
       rm.payment_status AS summary_payment_status,
       rm.amount_summary ->> 'total' AS summary_total,
       rm.amount_summary ->> 'currency' AS summary_currency
     FROM booking.quote_sessions q
     JOIN booking.checkout_contexts c
       ON c.quote_session_id = q.id
      AND c.property_id = q.property_id
     JOIN booking.guest_bookings b
       ON b.quote_session_id = q.id
      AND b.checkout_context_id = c.id
      AND b.property_id = q.property_id
     LEFT JOIN finance.payments p
       ON p.id = $5
      AND p.guest_booking_id = b.id
      AND p.property_id = b.property_id
     LEFT JOIN booking.direct_booking_summary_read_model rm
       ON rm.guest_booking_id = b.id
      AND rm.property_id = b.property_id
     WHERE q.id = $1
       AND c.id = $2
       AND b.id = $3
       AND q.property_id = $4`,
    [
      flow.quoteSessionId,
      flow.checkoutContextId,
      flow.guestBookingId,
      flow.propertyId,
      flow.paymentId,
    ],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.quote_status === "converted" &&
    row.checkout_status === "converted" &&
    row.lifecycle_status === flow.lifecycleStatus &&
    row.payment_status === flow.paymentStatus &&
    row.public_quote_reference === flow.publicQuoteReference &&
    row.public_booking_reference === flow.publicBookingReference &&
    row.payment_id === flow.paymentId &&
    row.payment_amount === flow.paymentAmount &&
    row.payment_currency === flow.currency &&
    row.payment_row_status === "paid" &&
    row.payment_booking_id === flow.guestBookingId &&
    row.summary_reference === flow.publicBookingReference &&
    row.summary_lifecycle_status === flow.lifecycleStatus &&
    row.summary_payment_status === flow.paymentStatus &&
    row.summary_total === flow.paymentAmount &&
    row.summary_currency === flow.currency;

  if (!matches) {
    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_FLOW_MISMATCH",
      owner: "Booking checkout",
      targetObject: "booking.guest_bookings",
      message: `Expected converted quote/checkout/booking/payment flow ${flow.guestBookingId} was not found`,
      expected:
        "Converted quote and checkout, confirmed paid booking, matching finance payment, and matching summary read-model",
      actual: row ? JSON.stringify(row) : "row missing",
      suggestedAction:
        "Check booking checkout fixture rows and target relationship preservation for quote/session/payment linkage.",
    });
  }
}

async function checkOwnershipLink(
  client: pg.Client,
  flow: BookingFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM identity.organization_resource_links link
       JOIN identity.product_entitlements entitlement
         ON entitlement.organization_id = link.organization_id
        AND entitlement.product = 'booking'
        AND entitlement.entitlement_key = 'booking-engine'
        AND entitlement.status = 'active'
       JOIN hotel_catalog.property_source_links source
         ON source.source_system = 'booking'
        AND source.source_table = 'booking_hotels'
        AND source.source_id = link.resource_id
        AND source.relationship = 'canonical_input'
        AND source.property_id = $3
       WHERE link.organization_id = $1
         AND link.product = 'booking'
         AND link.resource_type = 'booking_hotel'
         AND link.resource_id = $2
         AND link.relationship = 'owner'
         AND link.status = 'active'
     ) AS exists`,
    [flow.organizationId, flow.bookingHotelResourceId, flow.propertyId],
  );

  if (!result.rows[0].exists) {
    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_OWNERSHIP_LINK_MISMATCH",
      owner: "Booking checkout",
      targetObject: "identity.organization_resource_links",
      message: `Expected booking hotel ${flow.bookingHotelResourceId} to link organization ${flow.organizationId} to property ${flow.propertyId}`,
      expected:
        "Active booking hotel owner resource link, active booking-engine entitlement, and catalog source link for the same booking hotel",
      actual: "relationship not found",
      suggestedAction:
        "Check tenant/resource ownership backfill before accepting checkout rows for the property.",
    });
  }
}

async function checkRelatedCounts(
  client: pg.Client,
  flow: BookingFlowCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    guest_count: string;
    addon_selection_count: string;
    promo_application_count: string;
    status_event_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM booking.booking_guests
        WHERE guest_booking_id = $1) AS guest_count,
       (SELECT count(*)::text
        FROM booking.booking_addon_selections
        WHERE guest_booking_id = $1
          AND property_id = $2) AS addon_selection_count,
       (SELECT count(*)::text
        FROM booking.promo_applications
        WHERE guest_booking_id = $1
          AND property_id = $2) AS promo_application_count,
       (SELECT count(*)::text
        FROM booking.booking_status_events
        WHERE guest_booking_id = $1) AS status_event_count`,
    [flow.guestBookingId, flow.propertyId],
  );

  const row = result.rows[0];
  const actual = {
    guestCount: parseInt(row.guest_count, 10),
    addonSelectionCount: parseInt(row.addon_selection_count, 10),
    promoApplicationCount: parseInt(row.promo_application_count, 10),
    statusEventCount: parseInt(row.status_event_count, 10),
  };

  if (
    actual.guestCount !== flow.guestCount ||
    actual.addonSelectionCount !== flow.addonSelectionCount ||
    actual.promoApplicationCount !== flow.promoApplicationCount ||
    actual.statusEventCount !== flow.statusEventCount
  ) {
    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_RELATED_COUNT_MISMATCH",
      owner: "Booking checkout",
      targetObject: "booking.guest_bookings",
      message: `Related checkout row counts did not match for booking ${flow.guestBookingId}`,
      expected: JSON.stringify({
        guestCount: flow.guestCount,
        addonSelectionCount: flow.addonSelectionCount,
        promoApplicationCount: flow.promoApplicationCount,
        statusEventCount: flow.statusEventCount,
      }),
      actual: JSON.stringify(actual),
      suggestedAction:
        "Check fixture coverage for booking guest, addon, promo, and lifecycle event relationships.",
    });
  }
}

async function checkSummaryPublicSafety(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const forbiddenKeys = expected.bookingCheckoutChecks?.forbiddenSummaryKeys ?? [];
  if (forbiddenKeys.length === 0) return;

  const result = await client.query<{ guest_booking_id: string; summary: string }>(
    `SELECT guest_booking_id::text,
            concat_ws(
              ' ',
              public_reference,
              lifecycle_status,
              payment_status,
              guest_counts::text,
              room_summary::text,
              amount_summary::text,
              public_policy::text,
              source_freshness::text
            ) AS summary
     FROM booking.direct_booking_summary_read_model`,
  );

  for (const row of result.rows) {
    const matchedKey = forbiddenKeys.find((key) => row.summary.includes(key));
    if (!matchedKey) continue;

    findings.push({
      severity: "fail",
      code: "BOOKING_CHECKOUT_SUMMARY_PRIVATE_KEY_LEAK",
      owner: "Booking checkout",
      targetObject: "booking.direct_booking_summary_read_model",
      message: `Booking summary ${row.guest_booking_id} contains forbidden private key ${matchedKey}`,
      expected: "No guest PII or private checkout input in the summary read-model",
      actual: matchedKey,
      suggestedAction:
        "Keep guest PII in checkout/guest tables and project only public-safe booking summary fields.",
    });
  }
}

async function checkBookingCheckoutFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.bookingCheckoutChecks;
  if (!checks) return;

  for (const flow of checks.flows) {
    await checkBookingFlow(client, flow, findings);
    await checkOwnershipLink(client, flow, findings);
    await checkRelatedCounts(client, flow, findings);
  }

  await checkSummaryPublicSafety(client, expected, findings);
}

export async function checkBookingCheckoutParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkBookingCheckoutFixtures(client, expected, findings);
}
