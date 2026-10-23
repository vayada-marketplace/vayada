import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { replacementStayKey, type StoredPricingQuote } from "@vayada/domain-booking";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import {
  createPgPmsAcceptedPricingReservationPort,
  PmsAcceptedPricingReservationConflict,
} from "./pmsAcceptedPricingReservationRepository.js";
import { processNextPmsAcceptedPricingReservationJob } from "./pmsAcceptedPricingReservationWorker.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import { loadBookingNotificationSnapshot } from "../jobs/bookingEmails.js";
import { createTargetBookingReservationsReadRepository } from "../platform/bookingReservations.js";
import { createTargetBookingWebCheckoutAdapter } from "../routes/bookingWebPublic.js";
import { createBookingHostActions } from "./bookingHostActions.js";
import { targetBookingHostActionGuards } from "./bookingHostActionGuards.js";
import { createFinanceHostBookingPayments } from "./financeHostBookingPayments.js";
import {
  cancelAcceptedPricingStay,
  loadPricingBookingCancellation,
} from "./pricingBookingCancellation.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { loadCurrentPricingAcceptance } from "./pricingAcceptanceAmendments.js";
import {
  PMS_ACCEPTED_PRICING_JOB_TYPE,
  PMS_ACCEPTED_PRICING_JOB_VERSION,
  PMS_ACCEPTED_PRICING_QUEUE,
} from "./pricingPmsAcceptedReservationJob.js";

const url = process.env.TEST_DATABASE_URL;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** The same rooms at the same nightly prices on new dates: a stored quote that decodes like
 * a real repricing (one priced night per date, matching request key, lines and totals). */
function repricedQuote(
  quote: StoredPricingQuote,
  stay: { checkIn: string; checkOut: string },
  quoteId: string = randomUUID(),
): StoredPricingQuote {
  const dates: string[] = [];
  for (
    let day = Date.parse(`${stay.checkIn}T00:00:00Z`);
    day < Date.parse(`${stay.checkOut}T00:00:00Z`);
    day += 86_400_000
  )
    dates.push(new Date(day).toISOString().slice(0, 10));
  const moved = { ...quote.stay, ...stay };
  const rooms = quote.rooms.map((room) => ({
    ...room,
    nights: dates.map((date) => ({ ...room.nights[0]!, date })),
  }));
  const sum = (values: string[]) =>
    values.reduce((total, value) => total + BigInt(value), 0n).toString();
  const lines = rooms.flatMap((room) => [
    {
      id: `r-${room.selectionId}`,
      selectionId: room.selectionId,
      kind: "room" as const,
      amountMinor: sum(room.nights.map((night) => night.roomMinor)),
    },
    {
      id: `m-${room.selectionId}`,
      selectionId: room.selectionId,
      kind: "meal" as const,
      amountMinor: sum(room.nights.map((night) => night.mealMinor)),
    },
  ]);
  const totalMinor = sum(lines.map((line) => line.amountMinor));
  return {
    ...quote,
    quoteId,
    stay: moved,
    rooms,
    evidence: {
      ...quote.evidence,
      requestKey: replacementStayKey(moved),
      lines,
      totalMinor,
      dueNowMinor: "0",
      dueLaterMinor: totalMinor,
    },
  };
}
// Real holds/adoption/constraints, with a synthetic calendar/public-offer source.
// This does not exercise the future accepted-history port or queue consumer.
describe.skipIf(!url)("replacement PMS inventory adoption PostgreSQL", () => {
  it.each([
    "complete",
    "legacy-initial",
    "legacy-amendment",
    "legacy-invalid-amendment",
    "released",
    "missing-token",
    "manual-without-room",
    "channel-without-room",
    "partial",
    "wrong-receipt",
    "wrong-organization",
    "wrong-quote",
    "missing-acceptance",
    "changed-date",
    "changed-count",
    "edited",
    "canceled",
    "missing-bundle",
    "extra-token",
    "duplicate-token",
    "wrong-selection",
    "wrong-ages",
    "repository-complete",
    // VAY-2320: the same room type at two rates in one booking.
    "repository-complete-two-rates",
    "repository-released",
    "repository-wrong-organization",
    "repository-missing-acceptance",
    "repository-suspended-entitlement",
    "worker-complete",
    "repository-stay-cancel-before-adoption",
    "repository-stay-cancel-after-adoption",
    "repository-stay-cancel-guest-route",
    // VAY-2320: rooms with different cancellation terms in one booking.
    "repository-stay-cancel-guest-route-mixed-terms",
    "repository-stay-cancel-guest-paid-card",
    "repository-stay-cancel-host-guest-request",
    "repository-stay-cancel-host-paid-card",
    "repository-stay-cancel-host-reject",
    "repository-date-change",
    // VAY-2320: a room type booked at two rates keeps a line per rate in the policy impact.
    "repository-date-change-two-rates",
    "repository-stay-cancel-amended",
    "repository-stay-cancel-undecodable",
    // VAY-2110: a date-change amendment rebinds the stay to its repriced quote.
    "amended-complete",
    "amended-earlier-revision",
    "amended-stale-booking",
  ])("validates complete historical binding: %s", async (scenario) => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const db = await pool.connect();
    const propertyId = randomUUID(),
      organizationId = randomUUID(),
      bookingId = randomUUID();
    const acceptanceId = randomUUID(),
      commandReceiptId = randomUUID();
    const legacy = scenario.startsWith("legacy-"),
      worker = scenario.startsWith("worker-"),
      repository = scenario.startsWith("repository-") || worker,
      changeId = randomUUID();
    const amended = scenario.startsWith("amended-"),
      amendedQuoteId = randomUUID();
    // Amendments move the stay to days the accepted holds don't use.
    const amendedStay = { checkIn: "2026-10-03", checkOut: "2026-10-04" };
    const types = [randomUUID(), randomUUID()].sort();
    const f = pricingDraftFixture((q) => {
      Object.assign(q, { quoteId: randomUUID() });
      Object.assign(q.stay, { propertyId });
      const selected = structuredClone(q.stay.rooms[0]!);
      const priced = structuredClone(q.rooms[0]!);
      const term = structuredClone(q.evidence.terms[0]!);
      if (scenario.startsWith("repository-stay-cancel"))
        Object.assign(term, {
          cancellation: {
            kind: "flexible",
            terms: {
              type: "free_until_days_before_arrival",
              freeCancellationDeadlineDays: 365,
              afterDeadlinePenalty: "full_booking_amount",
              noShowPenalty: "full_booking_amount",
              flexibleCancellationType: "partial_refund",
              partialRefundTiers: [
                { minDaysBeforeCheckIn: 30, refundPercent: 100 },
                { minDaysBeforeCheckIn: 14, refundPercent: 50 },
                { minDaysBeforeCheckIn: 7, refundPercent: 25 },
              ],
            },
          },
        });
      const twoRates = scenario.endsWith("-two-rates");
      const selections = [types[0]!, types[1]!, types[0]!].map((roomTypeId, i) => ({
        ...selected,
        selectionId: `selection-${i}`,
        roomTypeId,
        ...(twoRates && i === 2 && { offerId: "second-rate" }),
        guests: { adults: 2, childAgesAtCheckIn: [6 + i] },
      }));
      Object.assign(q.stay, { rooms: selections });
      Object.assign(q, {
        rooms: selections.map((s) => ({
          ...priced,
          selectionId: s.selectionId,
          // A room at another rate is priced from that rate's own terms and nights.
          ...(s.offerId !== selected.offerId && {
            termsRevisions: { [s.offerId]: term.revision },
            nights: priced.nights.map((night) => ({
              ...night,
              sources: night.sources.map((source) => ({ ...source, offerId: s.offerId })),
            })),
          }),
        })),
      });
      // Free cancellation for the second room type, partial refunds for the first.
      const freeUntilWeek = {
        kind: "flexible",
        terms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 7,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
      };
      Object.assign(q.evidence, {
        terms: [
          ...types.map((roomTypeId, i) => ({
            ...term,
            roomTypeId,
            ...(scenario.endsWith("-mixed-terms") && i === 1 && { cancellation: freeUntilWeek }),
          })),
          ...(twoRates
            ? [
                {
                  ...term,
                  roomTypeId: types[0]!,
                  offerId: "second-rate",
                  cancellation: freeUntilWeek,
                },
              ]
            : []),
        ],
        lines: selections.flatMap((s) => [
          {
            id: `r-${s.selectionId}`,
            selectionId: s.selectionId,
            kind: "room" as const,
            amountMinor: "30000",
          },
          {
            id: `m-${s.selectionId}`,
            selectionId: s.selectionId,
            kind: "meal" as const,
            amountMinor: "6000",
          },
        ]),
        totalMinor: "108000",
        dueLaterMinor: "108000",
        requestKey: replacementStayKey(q.stay),
      });
    });
    const quote = f.current.quote;
    const { fingerprint, ...acceptedCommand } = f.command;
    try {
      await db.query("BEGIN");
      await db.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Synthetic adoption',($1::uuid)::text)",
        [organizationId],
      );
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic adoption')",
        [propertyId],
      );
      if (repository) {
        await db.query(
          `INSERT INTO identity.organization_resource_links
          (organization_id,product,resource_type,resource_id,relationship)
          VALUES($1,'pms','pms_property',$2,'owner')`,
          [organizationId, propertyId],
        );
        await db.query(
          `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key)
          VALUES($1,'pms','property-management')`,
          [organizationId],
        );
      }
      await db.query(
        `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits,base_rate_amount,currency)
        SELECT id,$1,id::text,'{"adults":2,"children":1,"total":3}',100,'EUR' FROM unnest($2::uuid[]) id`,
        [propertyId, types],
      );
      // Only calendar upstream audit fixtures bypass FKs; holds and adoption use live constraints.
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query(
        `INSERT INTO pms.operating_calendar_revisions
        (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
         property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
         idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
        VALUES($1,$2,1,'pms-operating-calendar.v1',1,'Europe/Berlin','year_round',0,2,1,
          gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now())`,
        [organizationId, propertyId],
      );
      await db.query(
        `INSERT INTO pms.operating_calendar_room_bindings
        (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,
         physical_capacity_count,starting_sellable_limit_count)
        SELECT $1,1,id,1,1,3,3 FROM unnest($2::uuid[]) id`,
        [propertyId, types],
      );
      await db.query("SET LOCAL session_replication_role=origin");
      await db.query(
        `INSERT INTO pms.inventory_days
        (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,inventory_revision,
         generated_sellable_limit_count,effective_sellable_limit_count,generated_source_revision,
         channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
        SELECT $1,id,day,3,3,1,1,3,3,1,0,0,0,0 FROM unnest($2::uuid[]) id,
          unnest($3::date[]) day`,
        [
          propertyId,
          types,
          amended || scenario.startsWith("repository-date-change")
            ? ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]
            : ["2026-10-01", "2026-10-02"],
        ],
      );
      await db.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
        (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
        VALUES($1::uuid,($1::uuid)::text,'Synthetic adoption',($1::uuid)::text,'en',ARRAY['en'],'complete')`,
        [propertyId],
      );
      await db.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
        (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,
         default_currency,supported_currencies,profile_status,freshness_status,public_setup_completeness)
        VALUES($1::uuid,($1::uuid)::text,($1::uuid)::text,'https://example.test','https://example.test','Europe/Berlin','EUR',ARRAY['EUR'],
          'public','fresh','{"status":"ready"}')`,
        [propertyId],
      );
      await db.query(
        `INSERT INTO distribution.public_room_offer_snapshots
        (property_id,room_type_id,stay_date,public_offer_key,available_rooms,base_price_amount,currency,
         payment_options,freshness_status,occupancy,rate_summary)
        SELECT property_id,room_type_id,stay_date,room_type_id::text,3,100,'EUR',ARRAY['pay_at_property'],
          'fresh','{"maxAdults":2,"maxChildren":1,"maxOccupancy":3}','{"minStayNights":1}'
        FROM pms.inventory_days WHERE property_id=$1`,
        [propertyId],
      );
      const reserve = (stay: { checkIn: string; checkOut: string }, quoteSessionId: string) =>
        createTargetPmsInventoryReservationPort().reserveBundle!({
          propertyId,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          currency: "EUR",
          quoteSessionId,
          occurredAt: new Date("2026-09-01T00:02:00Z"),
          transaction: db,
          lines: types.map((roomTypeId, i) => ({
            roomTypeId,
            publicOfferKey: roomTypeId,
            roomCount: i === 0 ? 2 : 1,
          })),
        });
      // A moved stay holds only its amendment's rooms; its accepted holds were released.
      const movedStay = amended && scenario !== "amended-stale-booking";
      const bundle = await reserve(
        movedStay ? amendedStay : quote.stay,
        scenario.includes("amendment")
          ? `change-request:${changeId}`
          : scenario === "wrong-quote"
            ? randomUUID()
            : movedStay
              ? amendedQuoteId
              : quote.quoteId,
      );
      const receiptRows = (
        await db.query(
          `SELECT receipt_id,room_type_id FROM pms.inventory_reservation_receipts WHERE property_id=$1`,
          [propertyId],
        )
      ).rows;
      const acceptedReceipts = bundle.receipts.map((receipt) =>
        movedStay ? { ...receipt, receiptId: randomUUID() } : { ...receipt },
      );
      const acceptedBundle = { ...bundle, receipts: acceptedReceipts };
      if (scenario === "missing-token") acceptedReceipts.pop();
      if (scenario === "extra-token")
        acceptedReceipts.push({ ...bundle.receipts[0]!, receiptId: randomUUID() });
      if (scenario === "duplicate-token") acceptedReceipts.push(bundle.receipts[0]!);
      let acceptedOrg = organizationId;
      if (scenario === "wrong-organization" || scenario === "repository-wrong-organization") {
        acceptedOrg = randomUUID();
        await db.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Other synthetic',($1::uuid)::text)",
          [acceptedOrg],
        );
      }
      await db.query(
        `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          quote.quoteId,
          propertyId,
          acceptedOrg,
          f.command.requestId,
          hash(f.command.requestId),
          { quote },
        ],
      );
      await db.query(
        `INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out,adults,children,room_count,currency,booking_metadata)
        VALUES($1::uuid,$2,($1::uuid)::text,'confirmed','unpaid',$3,$4,6,3,3,'EUR',$5)`,
        [
          bookingId,
          propertyId,
          quote.stay.checkIn,
          quote.stay.checkOut,
          {
            targetSource: "pricing_quote_draft",
            pricingQuoteId: quote.quoteId,
            pricingSelections: quote.stay.rooms,
            inventoryReservation: acceptedBundle,
          },
        ],
      );
      await db.query(
        `INSERT INTO platform.idempotency_keys
        (id,operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
         response_status_code,response_body_hash,completed_at,expires_at)
        VALUES($1,'booking','booking.pricing_quote.accept',$2,$3,'completed','property',$4,200,$3,now(),'infinity')`,
        [commandReceiptId, hash(f.command.requestId), fingerprint.slice(7), propertyId],
      );
      if (!["missing-acceptance", "repository-missing-acceptance"].includes(scenario) && !legacy)
        await db.query(
          `INSERT INTO booking.pricing_quote_acceptances
        (id,property_id,organization_id,pricing_quote_id,guest_booking_id,command_receipt_id,request_id,key_hash,
         request_fingerprint_hash,quote_snapshot,disclosure_json,disclosure_hash,guest_policy_source_revision,
         acceptance_command,inventory_reservation_bundle,billing_plan_snapshot,commission_terms_snapshot,finance_terms_captured_at,accepted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'guest-policy:1',$13,$14,'fixed',$15,$16,$17)`,
          [
            acceptanceId,
            propertyId,
            acceptedOrg,
            quote.quoteId,
            bookingId,
            commandReceiptId,
            f.command.requestId,
            hash(f.command.requestId),
            fingerprint.slice(7),
            quote,
            f.disclosure.disclosureJson,
            `sha256:${hash(f.disclosure.disclosureJson)}`,
            acceptedCommand,
            acceptedBundle,
            f.finance.commissionTermsSnapshot,
            f.finance.financeTermsCapturedAt,
            // After the quote expired: the stored row no longer decodes (VAY-2110 fallback).
            scenario === "repository-stay-cancel-undecodable"
              ? "2026-09-01T00:20:00Z"
              : "2026-09-01T00:02:00Z",
          ],
        );
      // VAY-2110: date changes append amendments; adoption follows the latest one.
      let assignedStay: { checkIn: string; checkOut: string } = quote.stay;
      if (amended) {
        const amend = async (
          revision: number,
          stay: { checkIn: string; checkOut: string },
          quoteId: string,
          holds: typeof bundle,
        ) => {
          // The repriced quote keeps every room and changes only the dates.
          const amendedQuote = repricedQuote(quote, stay, quoteId);
          const requestId = randomUUID();
          await db.query(
            `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
            VALUES($1,$2,$3,$4,$5,$6)`,
            [quoteId, propertyId, acceptedOrg, requestId, hash(requestId), { quote: amendedQuote }],
          );
          await db.query(
            `INSERT INTO booking.pricing_acceptance_amendments
            (acceptance_id,property_id,organization_id,guest_booking_id,revision,edit_revision,
             pricing_quote_id,quote_snapshot,inventory_reservation_bundle,source,source_id)
            VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,'host_edit',$9)`,
            [
              acceptanceId,
              propertyId,
              acceptedOrg,
              bookingId,
              revision,
              quoteId,
              amendedQuote,
              holds,
              randomUUID(),
            ],
          );
        };
        const moveBooking = (
          stay: { checkIn: string; checkOut: string },
          quoteId: string,
          holds: typeof bundle,
          editRevision: number,
        ) => {
          assignedStay = stay;
          return db.query(
            `UPDATE booking.guest_bookings SET check_in=$2,check_out=$3,edit_revision=$4,
            booking_metadata=booking_metadata||jsonb_build_object('pricingQuoteId',$5::text,'inventoryReservation',$6::jsonb)
            WHERE id=$1`,
            [bookingId, stay.checkIn, stay.checkOut, editRevision, quoteId, holds],
          );
        };
        if (scenario === "amended-stale-booking") {
          // The booking still matches its acceptance exactly, which 0312 alone would accept.
          await amend(1, amendedStay, amendedQuoteId, await reserve(amendedStay, amendedQuoteId));
        } else if (scenario === "amended-earlier-revision") {
          // The booking matches revision 1, but revision 2 is the stay's current price.
          const earlierStay = { checkIn: "2026-10-01", checkOut: "2026-10-02" },
            earlierQuoteId = randomUUID(),
            earlierHolds = await reserve(earlierStay, earlierQuoteId);
          await amend(1, earlierStay, earlierQuoteId, earlierHolds);
          await amend(2, amendedStay, amendedQuoteId, bundle);
          await moveBooking(earlierStay, earlierQuoteId, earlierHolds, 1);
          // Readers see the stay as the latest amendment prices it, too.
          expect(
            await loadCurrentPricingAcceptance(db, { propertyId, guestBookingId: bookingId }),
          ).toMatchObject({
            revision: 2,
            editRevision: 2,
            pricingQuoteId: amendedQuoteId,
            quote: { stay: amendedStay },
          });
        } else {
          await amend(1, amendedStay, amendedQuoteId, bundle);
          await moveBooking(amendedStay, amendedQuoteId, bundle, 1);
        }
      }
      if (legacy) {
        await db.query(
          `INSERT INTO booking.quote_sessions
          (id,property_id,request_hash,public_quote_reference,requested_check_in,requested_check_out,currency,expires_at)
          VALUES($1::uuid,$2,'legacy',($1::uuid)::text,$3,$4,'EUR',now())`,
          [quote.quoteId, propertyId, quote.stay.checkIn, quote.stay.checkOut],
        );
        const metadata = {
          inventoryReservation: bundle,
          selectedOffer: { roomSelection: quote.stay.rooms },
          ...(scenario.includes("amendment")
            ? {
                inventoryQuoteSessionId: `change-request:${changeId}`,
                lastAcceptedChangeRequestId: changeId,
              }
            : {}),
        };
        await db.query(
          "UPDATE booking.guest_bookings SET quote_session_id=$2,booking_metadata=$3 WHERE id=$1",
          [bookingId, quote.quoteId, metadata],
        );
        if (scenario === "legacy-amendment")
          await db.query(
            `INSERT INTO booking.booking_change_requests
          (id,guest_booking_id,request_type,requested_by,status,decided_at,requested_changes)
          VALUES($1,$2,'date_change','guest','accepted',now(),$3)`,
            [
              changeId,
              bookingId,
              {
                requestedCheckIn: quote.stay.checkIn,
                requestedCheckOut: quote.stay.checkOut,
                pricingSnapshot: { selectedOffer: { roomSelection: quote.stay.rooms } },
              },
            ],
          );
      }
      if (scenario === "released" || scenario === "repository-released")
        await createTargetPmsInventoryReservationPort().release({
          propertyId,
          transaction: db,
          reservation: bundle,
          occurredAt: new Date("2026-09-01T00:03:00Z"),
        });
      if (scenario === "repository-suspended-entitlement")
        await db.query(
          "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1",
          [organizationId],
        );
      await db.query("SAVEPOINT before_adoption");
      const snapshot = async () => ({
        receipts: (
          await db.query(
            "SELECT receipt_id,lifecycle_state,lifecycle_revision FROM pms.inventory_reservation_statuses WHERE property_id=$1 ORDER BY receipt_id",
            [propertyId],
          )
        ).rows,
        inventory: (
          await db.query(
            "SELECT room_type_id,stay_date,available_count,assigned_count,blocked_count FROM pms.inventory_days WHERE property_id=$1 ORDER BY room_type_id,stay_date",
            [propertyId],
          )
        ).rows,
        blocks: (
          await db.query(
            "SELECT id,status,source_assignment_id,source_inventory_reservation_receipt_id FROM pms.room_blocks WHERE property_id=$1 ORDER BY id",
            [propertyId],
          )
        ).rows,
        effects: (
          await db.query(
            `SELECT
              (SELECT count(*)::int FROM platform.domain_events WHERE property_id=$1) AS events,
              (SELECT count(*)::int FROM platform.outbox_events WHERE property_id=$1) AS outbox`,
            [propertyId],
          )
        ).rows[0],
      });
      const before = await snapshot();
      const acceptedPricingCommand = {
        contractVersion: "pms-accepted-pricing-reservation.v1" as const,
        acceptanceId,
        pricingQuoteId: quote.quoteId,
        guestBookingId: bookingId,
        propertyId,
        organizationId: acceptedOrg,
        acceptedAt: "2026-09-01T00:02:00.000Z",
        stay: { checkIn: quote.stay.checkIn, checkOut: quote.stay.checkOut },
        inventoryReservation: acceptedBundle,
        rooms: quote.stay.rooms.map((room, index) => ({
          position: index + 1,
          selectionId: room.selectionId,
          roomTypeId: room.roomTypeId,
          offerId: room.offerId,
          adults: room.guests.adults,
          childAgesAtCheckIn: room.guests.childAgesAtCheckIn,
        })),
      };
      const adopt = async () => {
        if (worker) {
          await db.query(
            `INSERT INTO platform.jobs
             (job_key,queue_name,job_type,tenant_scope,property_id,resource_product,
              resource_type,resource_id,correlation_id,payload)
             VALUES($1,$2,$3,'property',$4,'booking','guest_booking',$5,$6,$7)
             ON CONFLICT(queue_name,job_key) DO NOTHING`,
            [
              `pms:pricing-acceptance:${acceptanceId}:create:v1`,
              PMS_ACCEPTED_PRICING_QUEUE,
              PMS_ACCEPTED_PRICING_JOB_TYPE,
              propertyId,
              bookingId,
              acceptanceId,
              {
                version: PMS_ACCEPTED_PRICING_JOB_VERSION,
                propertyId,
                guestBookingId: bookingId,
                acceptanceId,
              },
            ],
          );
          return processNextPmsAcceptedPricingReservationJob(db, "worker:test");
        }
        if (repository)
          return createPgPmsAcceptedPricingReservationPort(db).adoptAcceptedPricingReservation(
            acceptedPricingCommand,
          );
        if (scenario === "changed-date")
          await db.query("UPDATE booking.guest_bookings SET check_out=check_out+1 WHERE id=$1", [
            bookingId,
          ]);
        if (scenario === "changed-count")
          await db.query("UPDATE booking.guest_bookings SET room_count=4 WHERE id=$1", [bookingId]);
        if (scenario === "edited")
          await db.query("UPDATE booking.guest_bookings SET edit_revision=1 WHERE id=$1", [
            bookingId,
          ]);
        if (scenario === "canceled")
          await db.query(
            "UPDATE booking.guest_bookings SET lifecycle_status='canceled' WHERE id=$1",
            [bookingId],
          );
        if (scenario === "missing-bundle")
          await db.query("UPDATE booking.guest_bookings SET booking_metadata='{}' WHERE id=$1", [
            bookingId,
          ]);
        for (const [i, selection] of quote.stay.rooms.entries()) {
          if (scenario === "partial" && i === 2) continue;
          const receiptId = receiptRows.find(
            (r) =>
              r.room_type_id === (scenario === "wrong-receipt" ? types[0] : selection.roomTypeId),
          )!.receipt_id;
          const physicalRoom = legacy ? randomUUID() : null;
          if (physicalRoom)
            await db.query(
              "INSERT INTO pms.rooms(id,property_id,room_type_id,room_number) VALUES($1::uuid,$2,$3,($1::uuid)::text)",
              [physicalRoom, propertyId, selection.roomTypeId],
            );
          await db.query(
            `INSERT INTO pms.operational_booking_assignments
            (property_id,guest_booking_id,room_type_id,position,assignment_status,source,stay_evidence_kind,
             check_in,check_out,adults,children,assignment_payload,room_id)
            VALUES($1,$2,$3,$4,'pending',$9,'exact',$5,$6,2,1,$7,$8)`,
            [
              propertyId,
              bookingId,
              selection.roomTypeId,
              i + 1,
              assignedStay.checkIn,
              assignedStay.checkOut,
              {
                ...(scenario === "channel-without-room"
                  ? { contractVersion: "channex-operational-assignment.v1" }
                  : {}),
                inventoryReservation: {
                  contractVersion: "pms-inventory-reservation-lifecycle.v1",
                  owner: "pms",
                  receiptId,
                },
                pricingAcceptance: {
                  acceptanceId,
                  selectionId: scenario === "wrong-selection" ? "wrong" : selection.selectionId,
                  offerId: selection.offerId,
                  childAgesAtCheckIn:
                    scenario === "wrong-ages" ? [1] : selection.guests.childAgesAtCheckIn,
                },
              },
              physicalRoom,
              scenario === "manual-without-room"
                ? "manual"
                : scenario === "channel-without-room"
                  ? "channel"
                  : "direct_booking",
            ],
          );
        }
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      };
      // VAY-2205: room-night revenue as a paid card stay records it, three lines a night at uneven
      // prices (330.01), so the kept share needs rounding. Returns the stay dates.
      const roomLines = [types[0]!, types[1]!, types[0]!];
      const seedRoomNights = async () => {
        const stayDates: string[] = [];
        for (
          let day = Date.parse(`${quote.stay.checkIn}T00:00:00Z`);
          day < Date.parse(`${quote.stay.checkOut}T00:00:00Z`);
          day += 86_400_000
        )
          stayDates.push(new Date(day).toISOString().slice(0, 10));
        for (const roomTypeId of new Set(roomLines))
          await db.query(
            "INSERT INTO booking.nightly_revenue_room_scopes(property_id,room_type_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [propertyId, roomTypeId],
          );
        for (const [night, stayDate] of stayDates.entries())
          for (const [index, roomTypeId] of roomLines.entries())
            await db.query(
              `INSERT INTO booking.nightly_revenue_evidence
                 (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,
                  occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,
                  line_position,corrects_evidence_id,command_key)
               VALUES($1,$2,$3,$4::date,$4::date,'EUR',$5::numeric,1,'room_night','confirmed','direct','exact',1,$6,NULL,$7)`,
              [
                propertyId,
                bookingId,
                roomTypeId,
                stayDate,
                ["100.01", "133.33", "96.67"][index],
                index + 1,
                `test-night:${night}:${index}`,
              ],
            );
        return stayDates;
      };
      // The hotel keeps 75% of what was paid, so the nights keep 75% of their room value as
      // retained revenue, split by room price and adding up exactly, on each stay date.
      const expectRetainedRevenue = async (stayDates: string[]) => {
        const roomValue = 330_01n * BigInt(stayDates.length);
        const retained = (
          await db.query(
            `SELECT stay_date::text AS "stayDate",recognized_on::text AS "recognizedOn",
               (gross_room_amount*100)::bigint::text AS cents,occupied_room_nights AS occupied,lifecycle_state AS state
             FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 AND economic_event='retained_charge'`,
            [bookingId],
          )
        ).rows;
        expect(retained).toHaveLength(stayDates.length * roomLines.length);
        expect(retained.reduce((sum, row) => sum + BigInt(row.cents), 0n)).toBe(
          (roomValue * 81000n * 2n + 108000n) / (108000n * 2n),
        );
        expect(
          retained.every((row) => row.recognizedOn === row.stayDate && row.occupied === 0),
        ).toBe(true);
        expect(new Set(retained.map((row) => row.state))).toEqual(new Set(["canceled"]));
      };
      if (
        [
          "complete",
          "legacy-initial",
          "legacy-amendment",
          "repository-complete",
          "repository-complete-two-rates",
          "worker-complete",
          "amended-complete",
        ].includes(scenario)
      ) {
        expect(await adopt()).toEqual(
          worker
            ? "adopted"
            : repository
              ? { outcome: "adopted", guestBookingId: bookingId, acceptanceId }
              : undefined,
        );
        if (amended) {
          // The amended acceptance decodes: the accepted consent with the repriced quote and holds.
          const current = await loadCurrentPricingAcceptance(db, {
            propertyId,
            guestBookingId: bookingId,
          });
          expect(current).toMatchObject({
            revision: 1,
            editRevision: 1,
            pricingQuoteId: amendedQuoteId,
            quote: { quoteId: amendedQuoteId, stay: amendedStay },
            reservation: bundle,
          });
          expect(current!.acceptance.quote.quoteId).toBe(quote.quoteId);
        }
        const after = await snapshot();
        expect(
          after.receipts.every(
            (r) => r.lifecycle_state === "handed_off" && r.lifecycle_revision === 2,
          ),
        ).toBe(true);
        if (repository) {
          expect(after.inventory.map(({ available_count }) => available_count)).toEqual(
            before.inventory.map(({ available_count }) => available_count),
          );
          expect(after.inventory.map(({ assigned_count }) => assigned_count)).toEqual([2, 2, 1, 1]);
          expect(after.effects).toEqual({
            events: before.effects.events + 2,
            outbox: before.effects.outbox + 6,
          });
        } else expect(after.inventory).toEqual(before.inventory);
        if (worker) {
          expect(await adopt()).toBe("empty");
          expect(
            (
              await db.query(
                `SELECT status,attempts_count,job_metadata->>'outcome' AS outcome
                 FROM platform.jobs WHERE job_key=$1`,
                [`pms:pricing-acceptance:${acceptanceId}:create:v1`],
              )
            ).rows,
          ).toEqual([{ status: "succeeded", attempts_count: 1, outcome: "adopted" }]);
        }
        expect(
          after.blocks.every(
            (b) => b.source_assignment_id && b.source_inventory_reservation_receipt_id === null,
          ),
        ).toBe(true);
        if (repository)
          expect(
            (
              await db.query(
                `SELECT position,assignment_status AS status,adults,children
                 FROM pms.operational_booking_assignments
                 WHERE property_id=$1 AND guest_booking_id=$2 ORDER BY position`,
                [propertyId, bookingId],
              )
            ).rows,
          ).toEqual([
            { position: 1, status: "pending", adults: 2, children: 1 },
            { position: 2, status: "pending", adults: 2, children: 1 },
            { position: 3, status: "pending", adults: 2, children: 1 },
          ]);
        if (scenario === "repository-complete") {
          // VAY-2320: emails and Booking Admin name every booked room type, not the first one,
          // in room order (the names sort the other way round).
          await db.query(
            "UPDATE pms.room_types SET name=CASE WHEN id=$1 THEN 'Zeta Deluxe' ELSE 'Alpha Garden' END WHERE id=ANY($2::uuid[])",
            [types[0], types],
          );
          const snapshot = await loadBookingNotificationSnapshot(db, {
            propertyId,
            guestBookingId: bookingId,
          });
          expect(snapshot?.accommodation).toBe("2 × Zeta Deluxe + Alpha Garden");
          const listed = await createTargetBookingReservationsReadRepository({
            connectionString: url!,
            pool: db as never,
          }).listReservationsByPropertyId(propertyId, {
            limit: 10,
            offset: 0,
            canReadGuestContact: false,
          });
          expect(
            listed.reservations.find((reservation) => reservation.id === bookingId)?.roomLines,
          ).toEqual([
            { roomTypeId: types[0], roomName: "Zeta Deluxe", roomCount: 2 },
            { roomTypeId: types[1], roomName: "Alpha Garden", roomCount: 1 },
          ]);
        }
        if (scenario.endsWith("-two-rates"))
          // Each room keeps its own rate: the third room is the first type at the second rate.
          expect(
            (
              await db.query(
                `SELECT position,room_type_id::text AS "roomTypeId",
                   assignment_payload->'pricingAcceptance'->>'offerId' AS "offerId"
                 FROM pms.operational_booking_assignments
                 WHERE property_id=$1 AND guest_booking_id=$2 ORDER BY position`,
                [propertyId, bookingId],
              )
            ).rows,
          ).toEqual([
            { position: 1, roomTypeId: types[0], offerId: quote.stay.rooms[0]!.offerId },
            { position: 2, roomTypeId: types[1], offerId: quote.stay.rooms[1]!.offerId },
            { position: 3, roomTypeId: types[0], offerId: "second-rate" },
          ]);
        if (repository && !worker) {
          expect(await adopt()).toEqual({
            outcome: "replayed",
            guestBookingId: bookingId,
            acceptanceId,
          });
          expect(await snapshot()).toEqual(after);
          await db.query("SAVEPOINT invalid_replay");
          await db.query("SET LOCAL session_replication_role=replica");
          await db.query("DELETE FROM booking.pricing_quote_acceptances WHERE id=$1", [
            acceptanceId,
          ]);
          await db.query("SET LOCAL session_replication_role=origin");
          await expect(adopt()).rejects.toBeInstanceOf(PmsAcceptedPricingReservationConflict);
          expect(await snapshot()).toEqual(after);
          await db.query("ROLLBACK TO SAVEPOINT invalid_replay");
          await db.query("UPDATE booking.guest_bookings SET edit_revision=1 WHERE id=$1", [
            bookingId,
          ]);
          await expect(adopt()).rejects.toBeInstanceOf(PmsAcceptedPricingReservationConflict);
          expect(await snapshot()).toEqual(after);
          await db.query("ROLLBACK TO SAVEPOINT invalid_replay");
          await db.query("SAVEPOINT position_21");
          await db.query("SET LOCAL session_replication_role=replica");
          await db.query(
            `INSERT INTO pms.operational_booking_assignments
             (property_id,guest_booking_id,room_type_id,position,assignment_status,source,
              stay_evidence_kind,check_in,check_out,adults,children)
             VALUES($1,$2,$3,21,'pending','manual','exact',$4,$5,1,0)`,
            [propertyId, bookingId, types[0], quote.stay.checkIn, quote.stay.checkOut],
          );
          await db.query("ROLLBACK TO SAVEPOINT position_21");
        } else
          await db.query(
            "UPDATE pms.operational_booking_assignments SET updated_at=updated_at WHERE guest_booking_id=$1",
            [bookingId],
          );
        expect(await snapshot()).toEqual(after);
      } else if (
        [
          "repository-released",
          "repository-wrong-organization",
          "repository-missing-acceptance",
          "repository-suspended-entitlement",
        ].includes(scenario)
      ) {
        await expect(adopt()).rejects.toBeInstanceOf(PmsAcceptedPricingReservationConflict);
        expect(await snapshot()).toEqual(before);
      } else if (scenario.startsWith("repository-stay-cancel-guest-route")) {
        // The two partial-refund rooms keep 75% of 36000 each; the free one gives everything back.
        const fee = scenario.endsWith("-mixed-terms") ? "54000" : "81000";
        // VAY-2100: the guest cancels an adopted v2 stay online, end to end on real PostgreSQL.
        expect(await adopt()).toMatchObject({ outcome: "adopted" });
        await db.query(
          "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1,$2,'canonical')",
          [propertyId, propertyId],
        );
        await db.query(
          `INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email)
           VALUES($1,'booker','Jane','Guest','jane@example.test')`,
          [bookingId],
        );
        // The adapter's own transaction becomes a savepoint inside this test's transaction.
        const nested = {
          query: (text: string, values?: unknown[]) =>
            db.query(
              (
                {
                  BEGIN: "SAVEPOINT guest_cancel",
                  COMMIT: "RELEASE SAVEPOINT guest_cancel",
                  ROLLBACK: "ROLLBACK TO SAVEPOINT guest_cancel",
                } as Record<string, string>
              )[text] ?? text,
              values,
            ),
        };
        const adapter = createTargetBookingWebCheckoutAdapter({
          pool: nested as unknown as pg.Pool,
          connectionString: url!,
          externalChanges: externalBookingChanges,
          inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        });
        const context = (key: string) => ({
          operation: "booking-cancel",
          requestId: `request-${key}`,
          correlationId: `correlation-${key}`,
          idempotencyKey: key,
          fingerprint: hash(key),
          occurredAt: new Date("2026-09-21T08:00:00Z"),
        });
        const guest = { guest_email: "jane@example.test" };
        expect(
          await adapter.cancelPreview(propertyId, bookingId, guest, context("p")),
        ).toMatchObject({
          amountPaid: 0,
          refundAmount: 0,
          refundPercentage: 0,
          cancellationFeeAmount: Number(fee) / 100,
          bookedTermsOutcome: { retainedMinor: fee, refundMinor: String(108000 - Number(fee)) },
        });
        await expect(
          adapter.cancel(
            propertyId,
            bookingId,
            { ...guest, expected_cancellation_fee_minor: "0" },
            context("stale"),
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
        await adapter.cancel(
          propertyId,
          bookingId,
          { ...guest, expected_cancellation_fee_minor: fee },
          context("c"),
        );
        // The adapter commit became a savepoint release: run the deferred checks a commit would.
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        const event = await db.query(
          `SELECT booking.lifecycle_status AS status, event.event_payload->'cancellationOutcome'->>'retainedMinor' AS fee
           FROM booking.guest_bookings booking JOIN booking.booking_status_events event
             ON event.guest_booking_id=booking.id AND event.event_type='guest_booking.canceled'
           WHERE booking.id=$1`,
          [bookingId],
        );
        expect(event.rows).toEqual([{ status: "canceled", fee }]);
        const assignments = await db.query(
          "SELECT DISTINCT assignment_status AS status FROM pms.operational_booking_assignments WHERE guest_booking_id=$1",
          [bookingId],
        );
        expect(assignments.rows).toEqual([{ status: "canceled" }]);
        const freed = await snapshot();
        expect(freed.inventory.map(({ assigned_count }) => assigned_count)).toEqual([0, 0, 0, 0]);
        expect(freed.inventory.map(({ available_count }) => available_count)).toEqual([3, 3, 3, 3]);
        // Nothing consumes pms.reservation.cancel; no PMS handoff is staged for a v2 stay.
        const jobs = await db.query(
          "SELECT job_type FROM platform.jobs WHERE resource_id=$1 AND job_type LIKE 'pms.%'",
          [bookingId],
        );
        expect(jobs.rows).toEqual([]);
      } else if (scenario === "repository-stay-cancel-guest-paid-card") {
        // VAY-2205: the guest cancels a paid card stay online; the cancel records the refund its
        // terms owe, and money moves only once Stripe answers (after the commit).
        expect(await adopt()).toMatchObject({ outcome: "adopted" });
        await db.query(
          "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1,$2,'canonical')",
          [propertyId, propertyId],
        );
        await db.query(
          `INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email)
           VALUES($1,'booker','Jane','Guest','jane@example.test')`,
          [bookingId],
        );
        const accountId = randomUUID(),
          paymentId = randomUUID();
        await db.query(
          `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status)
           VALUES($1,$2,'property','stripe',$3,'active')`,
          [accountId, propertyId, `acct_${bookingId.slice(0, 8)}`],
        );
        await db.query(
          `INSERT INTO finance.payments(id,property_id,guest_booking_id,provider_account_id,payment_kind,payment_method,
             status,amount,net_amount,currency,provider_payment_intent_id,visibility_class,paid_at,payment_metadata)
           VALUES($1,$2,$3,$4,'full','card','paid',1080,1080,'EUR',$5,'pms_finance',now(),'{"chargeType":"direct"}')`,
          [paymentId, propertyId, bookingId, accountId, `pi_${bookingId.slice(0, 8)}`],
        );
        await db.query(
          `UPDATE booking.guest_bookings SET payment_status='paid',active_card_payment_id=$2,
             booking_metadata=booking_metadata || '{"paymentMethod":"card"}' WHERE id=$1`,
          [bookingId, paymentId],
        );
        const stayDates = await seedRoomNights();
        // Each transaction (the cancel's, then the refund's after it) becomes a savepoint here.
        const savepointed = (name: string) => (text: string, values?: unknown[]) =>
          db.query(
            (
              {
                BEGIN: `SAVEPOINT ${name}`,
                COMMIT: `RELEASE SAVEPOINT ${name}`,
                ROLLBACK: `ROLLBACK TO SAVEPOINT ${name}`,
              } as Record<string, string>
            )[text] ?? text,
            values,
          );
        const nested = {
          query: savepointed("guest_cancel"),
          connect: async () => ({ query: savepointed("card_refund"), release: () => undefined }),
        };
        const createRefund = vi.fn(
          async (input: { amountMinor: number; commandId: string; paymentIntentId: string }) => ({
            refundId: "re_guest_cancel",
            status: "succeeded",
            amountMinor: input.amountMinor,
            currency: "EUR",
            paymentIntentId: input.paymentIntentId,
            commandId: input.commandId,
            failureReason: null,
          }),
        );
        const adapter = (stripe: boolean) =>
          createTargetBookingWebCheckoutAdapter({
            pool: nested as unknown as pg.Pool,
            connectionString: url!,
            externalChanges: externalBookingChanges,
            inventoryReservationPort: createTargetPmsInventoryReservationPort(),
            ...(stripe
              ? {
                  stripePaymentProvider: {
                    createRefund,
                    listRefunds: vi.fn(async () => []),
                    retrieveRefund: vi.fn(),
                  } as never,
                }
              : {}),
          });
        const context = (key: string) => ({
          operation: "booking-cancel",
          requestId: `request-${key}`,
          correlationId: `correlation-${key}`,
          idempotencyKey: key,
          fingerprint: hash(key),
          occurredAt: new Date("2026-09-21T08:00:00Z"),
        });
        const guest = { guest_email: "jane@example.test" };
        // Without Stripe, card refunds can't run: a paid stay stays refused online.
        await expect(
          adapter(false).cancelPreview(propertyId, bookingId, guest, context("p0")),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          await adapter(true).cancelPreview(propertyId, bookingId, guest, context("p")),
        ).toMatchObject({
          amountPaid: 1080,
          refundAmount: 270,
          refundPercentage: 25,
          cancellationFeeAmount: 810,
          bookedTermsOutcome: { retainedMinor: "81000", refundMinor: "27000" },
        });
        const cancel = adapter(true);
        for (const key of ["c", "c"])
          await cancel.cancel(
            propertyId,
            bookingId,
            { ...guest, expected_cancellation_fee_minor: "81000" },
            context(key),
          );
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(
          (
            await db.query(
              `SELECT booking.lifecycle_status AS status,booking.payment_status AS paid,
                 payment.status AS payment,payment.refunded_amount::text AS refunded
               FROM booking.guest_bookings booking JOIN finance.payments payment ON payment.id=booking.active_card_payment_id
               WHERE booking.id=$1`,
              [bookingId],
            )
          ).rows,
        ).toEqual([
          { status: "canceled", paid: "paid", payment: "partially_refunded", refunded: "270.00" },
        ]);
        await expectRetainedRevenue(stayDates);
        // One refund for the replayed cancel, asked of Stripe once after the commit and settled.
        expect(createRefund).toHaveBeenCalledOnce();
        expect(createRefund.mock.calls[0]![0]).toMatchObject({ amountMinor: 27000 });
        expect(
          (
            await db.query(
              `SELECT status,requested_by,amount::text AS amount,amount_minor::text AS minor
               FROM finance.card_refund_commands WHERE guest_booking_id=$1`,
              [bookingId],
            )
          ).rows,
        ).toEqual([
          { status: "succeeded", requested_by: "guest", amount: "270.00", minor: "27000" },
        ]);
      } else if (scenario === "repository-stay-cancel-host-guest-request") {
        // VAY-2100: PMS staff cancel an adopted v2 stay because the guest asked.
        expect(await adopt()).toMatchObject({ outcome: "adopted" });
        await db.query(
          `UPDATE booking.guest_bookings
           SET booking_metadata=booking_metadata || '{"paymentMethod":"pay_at_property"}' WHERE id=$1`,
          [bookingId],
        );
        const actorUserId = randomUUID();
        await db.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
          actorUserId,
          `${actorUserId}@example.test`,
        ]);
        const nested = {
          query: (text: string, values?: unknown[]) =>
            db.query(
              (
                {
                  BEGIN: "SAVEPOINT host_cancel",
                  COMMIT: "RELEASE SAVEPOINT host_cancel",
                  ROLLBACK: "ROLLBACK TO SAVEPOINT host_cancel",
                } as Record<string, string>
              )[text] ?? text,
              values,
            ),
        };
        const actions = createBookingHostActions({
          pool: nested as unknown as pg.Pool,
          inventory: createTargetPmsInventoryReservationPort(),
          guards: targetBookingHostActionGuards,
          now: () => new Date("2026-09-21T08:00:00Z"),
        });
        const hostScope = { propertyId, bookingId, actorUserId };
        const hostPreview = await actions.preview(hostScope, {
          action: "cancel",
          reason: "Guest emailed",
          cancellationKind: "guest_request",
        });
        expect(hostPreview.impact.cancellationOutcome).toMatchObject({
          daysBeforeCheckIn: 10,
          retainedMinor: "81000",
        });
        await actions.apply(hostScope, hostPreview.previewId, "host-guest-request");
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        const cancelled = await db.query(
          `SELECT booking.cancellation_reason AS reason,
             event.event_payload->'cancellationOutcome'->>'retainedMinor' AS fee
           FROM booking.guest_bookings booking JOIN booking.booking_status_events event
             ON event.guest_booking_id=booking.id AND event.event_type='guest_booking.canceled'
           WHERE booking.id=$1`,
          [bookingId],
        );
        expect(cancelled.rows).toEqual([{ reason: "guest_request", fee: "81000" }]);
        const assignments = await db.query(
          "SELECT DISTINCT assignment_status AS status FROM pms.operational_booking_assignments WHERE guest_booking_id=$1",
          [bookingId],
        );
        expect(assignments.rows).toEqual([{ status: "canceled" }]);
        const read = await createTargetPmsOperationsReadRepository({
          connectionString: url!,
          pool: db,
        }).findReservationByGuestBookingId(propertyId, bookingId);
        expect(read?.cancellationOutcome).toMatchObject({ retainedMinor: "81000" });
        // Nothing consumes pms.reservation.*; no PMS handoff is staged for a v2 stay.
        const jobs = await db.query(
          "SELECT job_type FROM platform.jobs WHERE resource_id=$1 AND job_type LIKE 'pms.%'",
          [bookingId],
        );
        expect(jobs.rows).toEqual([]);
      } else if (scenario === "repository-stay-cancel-host-paid-card") {
        // VAY-2205: PMS staff cancel a paid card stay; a property cancel would refund everything, a
        // guest request what the booked terms don't keep. Money moves only once Stripe answers.
        expect(await adopt()).toMatchObject({ outcome: "adopted" });
        const accountId = randomUUID(),
          paymentId = randomUUID(),
          actorUserId = randomUUID();
        await db.query(
          `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status)
           VALUES($1,$2,'property','stripe',$3,'active')`,
          [accountId, propertyId, `acct_${bookingId.slice(0, 8)}`],
        );
        await db.query(
          `INSERT INTO finance.payments(id,property_id,guest_booking_id,provider_account_id,payment_kind,payment_method,
             status,amount,net_amount,currency,provider_payment_intent_id,visibility_class,paid_at,payment_metadata)
           VALUES($1,$2,$3,$4,'full','card','paid',1080,1080,'EUR',$5,'pms_finance',now(),'{"chargeType":"direct"}')`,
          [paymentId, propertyId, bookingId, accountId, `pi_${bookingId.slice(0, 8)}`],
        );
        await db.query(
          `UPDATE booking.guest_bookings SET payment_status='paid',active_card_payment_id=$2,
             booking_metadata=booking_metadata || '{"paymentMethod":"card"}' WHERE id=$1`,
          [bookingId, paymentId],
        );
        const stayDates = await seedRoomNights();
        await db.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
          actorUserId,
          `${actorUserId}@example.test`,
        ]);
        // Each transaction (the cancel's, then the refund's after it) becomes a savepoint here.
        const savepointed = (name: string) => (text: string, values?: unknown[]) =>
          db.query(
            (
              {
                BEGIN: `SAVEPOINT ${name}`,
                COMMIT: `RELEASE SAVEPOINT ${name}`,
                ROLLBACK: `ROLLBACK TO SAVEPOINT ${name}`,
              } as Record<string, string>
            )[text] ?? text,
            values,
          );
        const nested = {
          query: savepointed("host_cancel"),
          connect: async () => ({ query: savepointed("card_refund"), release: () => undefined }),
        };
        const createRefund = vi.fn(
          async (input: { amountMinor: number; commandId: string; paymentIntentId: string }) => ({
            refundId: "re_host_cancel",
            status: "succeeded",
            amountMinor: input.amountMinor,
            currency: "EUR",
            paymentIntentId: input.paymentIntentId,
            commandId: input.commandId,
            failureReason: null,
          }),
        );
        const stripe = {
          createRefund,
          listRefunds: vi.fn(async () => []),
          retrieveRefund: vi.fn(),
        } as never;
        const actions = (refunds: boolean) =>
          createBookingHostActions({
            pool: nested as unknown as pg.Pool,
            inventory: createTargetPmsInventoryReservationPort(),
            guards: {
              ...targetBookingHostActionGuards,
              payment: createFinanceHostBookingPayments(refunds ? stripe : undefined),
            },
            now: () => new Date("2026-09-21T08:00:00Z"),
            ...(refunds ? { cardRefunds: stripe } : {}),
          });
        const hostScope = { propertyId, bookingId, actorUserId };
        // Without Stripe a paid card stay still needs a payment adjustment first.
        await expect(
          actions(false).preview(hostScope, { action: "cancel", reason: "Overbooked" }),
        ).rejects.toMatchObject({ code: "payment_adjustment_required" });
        const host = actions(true);
        expect(
          (await host.preview(hostScope, { action: "cancel", reason: "Overbooked" })).impact,
        ).toMatchObject({
          payment: "card_refund",
          cardRefund: { paidMinor: "108000", refundMinor: "108000", currency: "EUR" },
        });
        const asked = await host.preview(hostScope, {
          action: "cancel",
          reason: "Guest emailed",
          cancellationKind: "guest_request",
        });
        expect(asked.impact).toMatchObject({
          payment: "card_refund",
          cardRefund: { paidMinor: "108000", refundMinor: "27000" },
          cancellationOutcome: { retainedMinor: "81000" },
        });
        await host.apply(hostScope, asked.previewId, "host-paid-card");
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(
          (
            await db.query(
              `SELECT booking.lifecycle_status AS status,booking.payment_status AS paid,payment.status AS payment,
                 command.status AS refund,command.requested_by AS "by",command.amount::text AS amount
               FROM booking.guest_bookings booking
               JOIN finance.payments payment ON payment.id=booking.active_card_payment_id
               JOIN finance.card_refund_commands command ON command.payment_id=payment.id
               WHERE booking.id=$1`,
              [bookingId],
            )
          ).rows,
        ).toEqual([
          {
            status: "canceled",
            paid: "paid",
            payment: "partially_refunded",
            refund: "succeeded",
            by: "host",
            amount: "270.00",
          },
        ]);
        expect(createRefund).toHaveBeenCalledOnce();
        await expectRetainedRevenue(stayDates);
        // The reservation page reads the refund (VAY-2205).
        const read = await createTargetPmsOperationsReadRepository({
          connectionString: url!,
          pool: db,
        }).findReservationByGuestBookingId(propertyId, bookingId);
        expect(read?.cardRefund).toMatchObject({
          status: "succeeded",
          amount: "270.00",
          currency: "EUR",
          requestedBy: "host",
          failureReason: null,
        });
      } else if (scenario.startsWith("repository-date-change")) {
        // VAY-2110: PMS staff move an adopted v2 stay to new dates at its booked terms.
        expect(await adopt()).toMatchObject({ outcome: "adopted" });
        await db.query(
          `UPDATE booking.guest_bookings
           SET booking_metadata=booking_metadata || '{"paymentMethod":"pay_at_property"}' WHERE id=$1`,
          [bookingId],
        );
        const actorUserId = randomUUID();
        await db.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
          actorUserId,
          `${actorUserId}@example.test`,
        ]);
        const nested = {
          query: (text: string, values?: unknown[]) =>
            db.query(
              (
                {
                  BEGIN: "SAVEPOINT host_dates",
                  COMMIT: "RELEASE SAVEPOINT host_dates",
                  ROLLBACK: "ROLLBACK TO SAVEPOINT host_dates",
                } as Record<string, string>
              )[text] ?? text,
              values,
            ),
        };
        // The same rooms and nightly prices on the new dates; the live publication is not under
        // test here (its repricing has its own suites).
        let ratesChanged = false;
        const repriceStay = async (
          _client: unknown,
          input: { booked: StoredPricingQuote; checkIn: string; checkOut: string },
        ) => {
          const repriced = repricedQuote(input.booked, {
            checkIn: input.checkIn,
            checkOut: input.checkOut,
          });
          // The hotel's rates were republished: same amounts, a new rate source revision.
          const quote = ratesChanged
            ? {
                ...repriced,
                evidence: {
                  ...repriced.evidence,
                  revisions: {
                    ...repriced.evidence.revisions,
                    pms: `${repriced.evidence.revisions.pms}-republished`,
                  },
                },
              }
            : repriced;
          return {
            quote,
            calculation: {
              charges: {
                version: "booking.fixed-charge-amounts.v1",
                currency: quote.stay.currency,
                requestKey: quote.evidence.requestKey,
                sourceRevision: quote.evidence.revisions.charges,
                basisEvidenceId: quote.evidence.mandatoryChargeEvidenceId,
                includedChargeMinor: "0",
                additionalChargeMinor: "0",
                charges: [],
              },
            },
          };
        };
        let failAfterMove = true;
        let soldOut = false;
        const actions = createBookingHostActions({
          pool: nested as unknown as pg.Pool,
          inventory: createTargetPmsInventoryReservationPort(),
          guards: {
            ...targetBookingHostActionGuards,
            async completeDateEdit(client, input) {
              await targetBookingHostActionGuards.completeDateEdit(client, input);
              if (failAfterMove) throw new Error("Simulated failure after the move");
            },
          },
          now: () => new Date("2026-09-21T08:00:00Z"),
          repriceStay: repriceStay as never,
          // Real holds through the inventory port: this fixture's synthetic calendar isn't the
          // current-calendar evidence the pricing-v2 quote reservation requires.
          reserveStayHolds: (client, input) => {
            if (soldOut) throw new Error("Quote inventory is unavailable");
            const counts = new Map<string, number>();
            for (const room of input.rooms)
              counts.set(room.roomTypeId, (counts.get(room.roomTypeId) ?? 0) + 1);
            return createTargetPmsInventoryReservationPort().reserveBundle!({
              propertyId: input.propertyId,
              checkIn: input.checkIn,
              checkOut: input.checkOut,
              currency: "EUR",
              quoteSessionId: input.quoteId,
              occurredAt: new Date("2026-09-21T08:00:00Z"),
              transaction: client,
              lines: [...counts].map(([roomTypeId, roomCount]) => ({
                roomTypeId,
                publicOfferKey: roomTypeId,
                roomCount,
              })),
            });
          },
        });
        const hostScope = { propertyId, bookingId, actorUserId };
        const holds = async () =>
          (
            await db.query(
              `SELECT receipt.receipt_id::text AS id,receipt.check_in::text AS "checkIn",
                 status.lifecycle_state AS state
               FROM pms.inventory_reservation_receipts receipt
               JOIN pms.inventory_reservation_statuses status USING(receipt_id)
               WHERE receipt.property_id=$1 ORDER BY receipt.check_in,receipt.receipt_id`,
              [propertyId],
            )
          ).rows;
        const occupied = async () =>
          (
            await db.query(
              `SELECT room_type_id::text AS room,stay_date::text AS date,assigned_count AS assigned
               FROM pms.inventory_days WHERE property_id=$1 AND assigned_count>0
               ORDER BY stay_date,room_type_id`,
              [propertyId],
            )
          ).rows;
        const heldBefore = await holds();
        const occupiedBefore = await occupied();
        // The adopted stay occupies both accepted nights: two rooms of one type, one of the other.
        expect(occupiedBefore.map(({ date, assigned }) => [date, assigned])).toEqual([
          ["2026-10-01", 2],
          ["2026-10-01", 1],
          ["2026-10-02", 2],
          ["2026-10-02", 1],
        ]);
        const hostPreview = await actions.preview(hostScope, {
          action: "edit_dates",
          checkIn: amendedStay.checkIn,
          checkOut: amendedStay.checkOut,
          reason: "Guest asked",
        });
        // Three rooms at 300.00 + 60.00 a night, for one night instead of two.
        expect(hostPreview.impact).toMatchObject({
          checkIn: amendedStay.checkIn,
          checkOut: amendedStay.checkOut,
          newTotalAmount: "540.00",
          inventory: "replace",
        });
        if (scenario.endsWith("-two-rates")) {
          // The first type's two rooms are on two rates with different terms: one line each.
          const policy = hostPreview.impact.cancellationPolicy as unknown as {
            type: string;
            lines: { roomTypeId: string; roomCount: number }[];
          };
          expect(policy.type).toBe("mixed_room");
          expect(policy.lines.map((line) => [line.roomTypeId, line.roomCount]).sort()).toEqual(
            [
              [types[0], 1],
              [types[0], 1],
              [types[1], 1],
            ].sort(),
          );
        }
        // A preview proves the new nights can be held and keeps nothing.
        expect(await holds()).toEqual(heldBefore);
        expect(await occupied()).toEqual(occupiedBefore);
        const effects = async () =>
          (
            await db.query(
              `SELECT destination,resource_id AS room,payload->'dateRange' AS range
               FROM platform.outbox_events WHERE property_id=$1 AND payload->>'triggerRefId'=$2`,
              [propertyId, hostPreview.previewId],
            )
          ).rows;
        const unmoved = async () =>
          (
            await db.query(
              `SELECT check_in::text AS "checkIn",edit_revision AS revision,
                 (SELECT count(*)::int FROM booking.pricing_acceptance_amendments
                   WHERE guest_booking_id=$1) AS amendments
               FROM booking.guest_bookings WHERE id=$1`,
              [bookingId],
            )
          ).rows[0];
        // Rates republished after the preview need a new preview; new dates that sold out are
        // refused. Neither writes anything (checked below).
        ratesChanged = true;
        await expect(
          actions.apply(hostScope, hostPreview.previewId, "host-date-change"),
        ).rejects.toMatchObject({ code: "stale_preview" });
        ratesChanged = false;
        soldOut = true;
        await expect(
          actions.apply(hostScope, hostPreview.previewId, "host-date-change"),
        ).rejects.toMatchObject({
          code: "inventory_unavailable",
          message: "The new dates are not available for every booked room.",
        });
        soldOut = false;
        // A failure after the stays moved undoes the whole change.
        await expect(
          actions.apply(hostScope, hostPreview.previewId, "host-date-change"),
        ).rejects.toThrow("Simulated failure after the move");
        expect(await holds()).toEqual(heldBefore);
        expect(await occupied()).toEqual(occupiedBefore);
        expect(await effects()).toEqual([]);
        expect(await unmoved()).toEqual({ checkIn: "2026-10-01", revision: 0, amendments: 0 });
        failAfterMove = false;
        await expect(
          actions.apply(hostScope, hostPreview.previewId, "host-date-change"),
        ).resolves.toEqual({ bookingId, lifecycleStatus: "confirmed" });
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        // Only the new night is occupied: the accepted nights are free again, and the new holds
        // were handed to the moved assignments. Adopted holds stay handed off (a final state).
        expect(await occupied()).toEqual(
          occupiedBefore
            .filter(({ date }) => date === "2026-10-01")
            .map((night) => ({ ...night, date: amendedStay.checkIn })),
        );
        const heldAfter = await holds();
        const oldIds = new Set(heldBefore.map((hold) => hold.id));
        expect(heldAfter.filter((hold) => oldIds.has(hold.id))).toEqual(heldBefore);
        const fresh = heldAfter.filter((hold) => !oldIds.has(hold.id));
        expect(fresh).toHaveLength(types.length);
        expect(
          fresh.every(
            (hold) => hold.checkIn === amendedStay.checkIn && hold.state === "handed_off",
          ),
        ).toBe(true);
        const moved = (
          await db.query(
            `SELECT check_in::text AS "checkIn",check_out::text AS "checkOut",edit_revision AS revision,
               total_amount::text AS total,booking_metadata->>'pricingQuoteId' AS quote
             FROM booking.guest_bookings WHERE id=$1`,
            [bookingId],
          )
        ).rows[0];
        const amendment = (
          await db.query(
            `SELECT revision,edit_revision AS "editRevision",pricing_quote_id::text AS quote,
               quote_snapshot#>>'{stay,checkIn}' AS "checkIn"
             FROM booking.pricing_acceptance_amendments WHERE guest_booking_id=$1`,
            [bookingId],
          )
        ).rows;
        expect(amendment).toEqual([
          { revision: 1, editRevision: 1, quote: moved.quote, checkIn: amendedStay.checkIn },
        ]);
        expect(moved).toMatchObject({ ...amendedStay, revision: 1, total: "540.00" });
        const assignments = await db.query(
          `SELECT DISTINCT check_in::text AS "checkIn",check_out::text AS "checkOut",
             assignment_status AS status
           FROM pms.operational_booking_assignments WHERE guest_booking_id=$1`,
          [bookingId],
        );
        expect(assignments.rows).toEqual([{ ...amendedStay, status: "pending" }]);
        const revenue = await db.query(
          `SELECT stay_date::text AS date,sum(occupied_room_nights)::int AS occupied
           FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1
           GROUP BY stay_date ORDER BY stay_date`,
          [bookingId],
        );
        expect(revenue.rows.filter((row) => row.occupied > 0)).toEqual([
          { date: amendedStay.checkIn, occupied: 3 },
        ]);
        const events = await db.query(
          "SELECT count(*)::int AS n FROM booking.booking_status_events WHERE guest_booking_id=$1 AND event_type='guest_booking.host_dates_updated'",
          [bookingId],
        );
        expect(events.rows).toEqual([{ n: 1 }]);
        // The channel manager, public bookability and calendar hear about the freed and the new
        // nights of each room type.
        const changed = await effects();
        expect(changed).toHaveLength(3 * types.length * 2);
        for (const destination of [
          "pms.channel-manager",
          "distribution.public-bookability",
          "pms.calendar-projection",
        ])
          for (const room of types)
            for (const range of [
              { from: "2026-10-01", to: "2026-10-02" },
              { from: amendedStay.checkIn, to: amendedStay.checkIn },
            ])
              expect(changed).toContainEqual({ destination, room, range });
      } else if (scenario === "repository-stay-cancel-amended") {
        // VAY-2110: the host moved check-in from 1 to 2 October; the stay was repriced at one night.
        const port = createTargetPmsInventoryReservationPort(),
          at = new Date("2026-09-10T00:00:00Z"),
          movedId = randomUUID();
        await port.release({
          propertyId,
          transaction: db,
          reservation: acceptedBundle,
          occurredAt: at,
        });
        // The same rooms, nightly prices and booked terms (0477 pins them) on the new date.
        const moved = repricedQuote(
          quote,
          { checkIn: "2026-10-02", checkOut: "2026-10-03" },
          movedId,
        );
        const movedHolds = await port.reserveBundle!({
          propertyId,
          checkIn: "2026-10-02",
          checkOut: "2026-10-03",
          currency: "EUR",
          quoteSessionId: movedId,
          occurredAt: at,
          transaction: db,
          lines: types.map((roomTypeId, i) => ({
            roomTypeId,
            publicOfferKey: roomTypeId,
            roomCount: i === 0 ? 2 : 1,
          })),
        });
        const requestId = randomUUID();
        await db.query(
          `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [movedId, propertyId, acceptedOrg, requestId, hash(requestId), { quote: moved }],
        );
        await db.query(
          `INSERT INTO booking.pricing_acceptance_amendments
          (acceptance_id,property_id,organization_id,guest_booking_id,revision,edit_revision,
           pricing_quote_id,quote_snapshot,inventory_reservation_bundle,source,source_id)
          VALUES($1,$2,$3,$4,1,1,$5,$6,$7,'host_edit',$8)`,
          [
            acceptanceId,
            propertyId,
            acceptedOrg,
            bookingId,
            movedId,
            moved,
            movedHolds,
            randomUUID(),
          ],
        );
        await db.query(
          `UPDATE booking.guest_bookings SET check_in='2026-10-02',edit_revision=1,
          booking_metadata=booking_metadata||jsonb_build_object('pricingQuoteId',$2::text,'inventoryReservation',$3::jsonb)
          WHERE id=$1`,
          [bookingId, movedId, movedHolds],
        );
        const movedStay = {
          checkIn: "2026-10-02",
          checkOut: "2026-10-03",
          roomCount: 3,
          currency: "EUR",
        };
        const cancellation = (stay: typeof movedStay) =>
          loadPricingBookingCancellation(db, {
            propertyId,
            guestBookingId: bookingId,
            stay,
            cancelledAt: new Date("2026-09-18T08:00:00Z"),
          });
        // 18 September is 14 days before the new check-in (50%), 13 before the accepted one (25%);
        // the base is the repriced one-night total.
        expect(await cancellation(movedStay)).toMatchObject({
          daysBeforeCheckIn: 14,
          totalMinor: "54000",
          refundMinor: "27000",
          retainedMinor: "27000",
        });
        expect(await cancellation({ ...movedStay, checkIn: "2026-10-01" })).toBeNull();
        // Freeing the stay releases the amendment's holds, not the accepted (already released) ones.
        const free = () =>
          cancelAcceptedPricingStay(db, port, {
            propertyId,
            guestBookingId: bookingId,
            commandId: randomUUID(),
            fingerprint: hash(scenario),
            occurredAt: new Date("2026-09-18T08:00:00Z"),
          });
        expect(await free()).toEqual({ released: 2, canceledAssignments: 0 });
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(await free()).toEqual({ released: 0, canceledAssignments: 0 });
        expect((await snapshot()).receipts.map(({ lifecycle_state }) => lifecycle_state)).toEqual([
          "released",
          "released",
          "released",
          "released",
        ]);
      } else if (scenario === "repository-stay-cancel-undecodable") {
        // A stored acceptance that no longer decodes: no online fee, but freeing never gets stuck.
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          expect(
            await loadPricingBookingCancellation(db, {
              propertyId,
              guestBookingId: bookingId,
              stay: {
                checkIn: "2026-10-01",
                checkOut: "2026-10-03",
                roomCount: 3,
                currency: "EUR",
              },
              cancelledAt: new Date("2026-09-21T08:00:00Z"),
            }),
          ).toBeNull();
          const free = () =>
            cancelAcceptedPricingStay(db, createTargetPmsInventoryReservationPort(), {
              propertyId,
              guestBookingId: bookingId,
              commandId: randomUUID(),
              fingerprint: hash(scenario),
              occurredAt: new Date("2026-09-21T08:00:00Z"),
            });
          expect(await free()).toEqual({ released: 2, canceledAssignments: 0 });
          await db.query("SET CONSTRAINTS ALL IMMEDIATE");
          expect(await free()).toEqual({ released: 0, canceledAssignments: 0 });
          expect(warn).toHaveBeenCalledWith(
            "Pricing acceptance no longer decodes; releasing its stored holds.",
            { propertyId, guestBookingId: bookingId },
          );
        } finally {
          warn.mockRestore();
        }
      } else if (scenario === "repository-stay-cancel-host-reject") {
        // A v2 request the PMS never adopted: rejecting it releases the hold, with no handoff.
        await db.query(
          `UPDATE booking.guest_bookings SET lifecycle_status='pending_payment',
           booking_metadata=booking_metadata || '{"paymentMethod":"pay_at_property","acceptanceMode":"request"}'
           WHERE id=$1`,
          [bookingId],
        );
        const actorUserId = randomUUID();
        await db.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
          actorUserId,
          `${actorUserId}@example.test`,
        ]);
        const nested = {
          query: (text: string, values?: unknown[]) =>
            db.query(
              (
                {
                  BEGIN: "SAVEPOINT host_reject",
                  COMMIT: "RELEASE SAVEPOINT host_reject",
                  ROLLBACK: "ROLLBACK TO SAVEPOINT host_reject",
                } as Record<string, string>
              )[text] ?? text,
              values,
            ),
        };
        const actions = createBookingHostActions({
          pool: nested as unknown as pg.Pool,
          inventory: createTargetPmsInventoryReservationPort(),
          guards: targetBookingHostActionGuards,
          now: () => new Date("2026-09-21T08:00:00Z"),
        });
        const hostScope = { propertyId, bookingId, actorUserId };
        const hostPreview = await actions.preview(hostScope, {
          action: "reject",
          reason: "No rooms that night",
        });
        await actions.apply(hostScope, hostPreview.previewId, "host-reject");
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        const rejected = await db.query(
          "SELECT lifecycle_status AS status FROM booking.guest_bookings WHERE id=$1",
          [bookingId],
        );
        expect(rejected.rows).toEqual([{ status: "declined" }]);
        expect((await snapshot()).receipts.map(({ lifecycle_state }) => lifecycle_state)).toEqual([
          "released",
          "released",
        ]);
        const jobs = await db.query(
          "SELECT job_type FROM platform.jobs WHERE resource_id=$1 AND job_type LIKE 'pms.%'",
          [bookingId],
        );
        expect(jobs.rows).toEqual([]);
      } else if (scenario.startsWith("repository-stay-cancel")) {
        // VAY-2100: booked tiers come from the acceptance; 10 days out meets the 7-day 25% tier.
        // Days count in the frozen Europe/Berlin timezone.
        const stay = {
          checkIn: "2026-10-01",
          checkOut: "2026-10-03",
          roomCount: 3,
          currency: "EUR",
        };
        const cancellation = (cancelledAt: string, changed: Partial<typeof stay> = {}) =>
          loadPricingBookingCancellation(db, {
            propertyId,
            guestBookingId: bookingId,
            stay: { ...stay, ...changed },
            cancelledAt: new Date(cancelledAt),
          });
        expect(await cancellation("2026-09-21T08:00:00Z")).toMatchObject({
          daysBeforeCheckIn: 10,
          totalMinor: "108000",
          refundMinor: "27000",
          retainedMinor: "81000",
          rooms: quote.stay.rooms.map(({ selectionId }) => ({
            selectionId,
            rule: "partial_refund",
            refundPercent: 25,
            matchedTierMinDays: 7,
            baseMinor: "36000",
          })),
        });
        expect((await cancellation("2026-08-31T08:00:00Z"))?.refundMinor).toBe("108000");
        // 22:30 UTC is already the next day in Berlin: 13 days (25%), not 14 (50%).
        expect(await cancellation("2026-09-17T22:30:00Z")).toMatchObject({
          daysBeforeCheckIn: 13,
          refundMinor: "27000",
        });
        for (const changed of [
          { checkIn: "2026-10-02" },
          { checkOut: "2026-10-04" },
          { roomCount: 2 },
          { currency: "USD" },
        ])
          expect(await cancellation("2026-09-21T08:00:00Z", changed)).toBeNull();
        const free = () =>
          cancelAcceptedPricingStay(db, createTargetPmsInventoryReservationPort(), {
            propertyId,
            guestBookingId: bookingId,
            commandId: randomUUID(),
            fingerprint: hash(scenario),
            occurredAt: new Date("2026-09-21T08:00:00Z"),
          });
        if (scenario.endsWith("after-adoption")) {
          expect(await adopt()).toMatchObject({ outcome: "adopted" });
          // Booking Detail reads the booked terms from the acceptance, and the recorded outcome.
          const readReservation = () =>
            createTargetPmsOperationsReadRepository({
              connectionString: url!,
              pool: db,
            }).findReservationByGuestBookingId(propertyId, bookingId);
          const booked = await readReservation();
          expect(booked?.assignments.map((a) => a.bookedCancellation)).toEqual(
            [1, 2, 3].map(() => quote.evidence.terms[0]!.cancellation),
          );
          expect(booked?.cancellationOutcome).toBeUndefined();
          const recorded = await cancellation("2026-09-21T08:00:00Z");
          await db.query(
            `INSERT INTO booking.booking_status_events
             (guest_booking_id,event_type,from_status,to_status,actor_type,public_visible,public_message,event_payload)
             VALUES($1,'guest_booking.canceled','confirmed','canceled','guest',true,'Booking updated.',$2)`,
            [bookingId, { requestId: "r", cancellationOutcome: recorded }],
          );
          expect((await readReservation())?.cancellationOutcome).toEqual(recorded);
          expect(await free()).toEqual({ released: 0, canceledAssignments: 3 });
          await db.query("SET CONSTRAINTS ALL IMMEDIATE");
          const assignments = await db.query(
            "SELECT assignment_status AS status FROM pms.operational_booking_assignments WHERE guest_booking_id=$1",
            [bookingId],
          );
          expect(assignments.rows).toEqual([1, 2, 3].map(() => ({ status: "canceled" })));
        } else {
          expect(await free()).toEqual({ released: 2, canceledAssignments: 0 });
          await db.query("SET CONSTRAINTS ALL IMMEDIATE");
          await db.query("SAVEPOINT late_adoption");
          await expect(adopt()).rejects.toBeInstanceOf(PmsAcceptedPricingReservationConflict);
          await db.query("ROLLBACK TO SAVEPOINT late_adoption");
        }
        expect(await free()).toEqual({ released: 0, canceledAssignments: 0 });
        const freed = await snapshot();
        expect(freed.inventory.map(({ assigned_count }) => assigned_count)).toEqual([0, 0, 0, 0]);
        expect(freed.inventory.map(({ available_count }) => available_count)).toEqual([3, 3, 3, 3]);
        expect(freed.receipts.map(({ lifecycle_state }) => lifecycle_state)).toEqual(
          scenario.endsWith("after-adoption")
            ? ["handed_off", "handed_off"]
            : ["released", "released"],
        );
      } else if (scenario === "channel-without-room") {
        await adopt();
        expect(await snapshot()).toEqual(before);
      } else if (scenario === "amended-stale-booking" || scenario === "amended-earlier-revision") {
        // The common ending below rolls back and checks that nothing changed.
        await expect(adopt()).rejects.toMatchObject({
          constraint: "chk_pms_direct_booking_receipt_handoff_scope",
          message: "replacement inventory has no matching unchanged acceptance",
        });
      } else
        await expect(adopt()).rejects.toMatchObject({
          constraint:
            scenario === "manual-without-room"
              ? "chk_pms_exact_assignments_room"
              : "chk_pms_direct_booking_receipt_handoff_scope",
        });
      await db.query("ROLLBACK TO SAVEPOINT before_adoption");
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM pms.operational_booking_assignments WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await pool.end();
    }
  });
});
