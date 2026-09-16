import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";

const url = process.env.TEST_DATABASE_URL;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
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
  ])("validates complete historical binding: %s", async (scenario) => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    const propertyId = randomUUID(),
      organizationId = randomUUID(),
      bookingId = randomUUID();
    const acceptanceId = randomUUID(),
      commandReceiptId = randomUUID();
    const legacy = scenario.startsWith("legacy-"),
      changeId = randomUUID();
    const types = [randomUUID(), randomUUID()].sort();
    const f = pricingDraftFixture((q) => {
      Object.assign(q, { quoteId: randomUUID() });
      Object.assign(q.stay, { propertyId });
      const selected = structuredClone(q.stay.rooms[0]!);
      const priced = structuredClone(q.rooms[0]!);
      const term = structuredClone(q.evidence.terms[0]!);
      const selections = [types[0]!, types[1]!, types[0]!].map((roomTypeId, i) => ({
        ...selected,
        selectionId: `selection-${i}`,
        roomTypeId,
        guests: { adults: 2, childAgesAtCheckIn: [6 + i] },
      }));
      Object.assign(q.stay, { rooms: selections });
      Object.assign(q, {
        rooms: selections.map((s) => ({ ...priced, selectionId: s.selectionId })),
      });
      Object.assign(q.evidence, {
        terms: types.map((roomTypeId) => ({ ...term, roomTypeId })),
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
          unnest(ARRAY[DATE '2026-10-01',DATE '2026-10-02']) day`,
        [propertyId, types],
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
      const bundle = await createTargetPmsInventoryReservationPort().reserveBundle!({
        propertyId,
        checkIn: quote.stay.checkIn,
        checkOut: quote.stay.checkOut,
        currency: "EUR",
        quoteSessionId: scenario.includes("amendment")
          ? `change-request:${changeId}`
          : scenario === "wrong-quote"
            ? randomUUID()
            : quote.quoteId,
        occurredAt: new Date("2026-09-01T00:02:00Z"),
        transaction: db,
        lines: types.map((roomTypeId, i) => ({
          roomTypeId,
          publicOfferKey: roomTypeId,
          roomCount: i === 0 ? 2 : 1,
        })),
      });
      const receiptRows = (
        await db.query(
          `SELECT receipt_id,room_type_id FROM pms.inventory_reservation_receipts WHERE property_id=$1`,
          [propertyId],
        )
      ).rows;
      const acceptedReceipts = bundle.receipts.map((receipt) => ({ ...receipt }));
      const acceptedBundle = { ...bundle, receipts: acceptedReceipts };
      if (scenario === "missing-token") acceptedReceipts.pop();
      if (scenario === "extra-token")
        acceptedReceipts.push({ ...bundle.receipts[0]!, receiptId: randomUUID() });
      if (scenario === "duplicate-token") acceptedReceipts.push(bundle.receipts[0]!);
      let acceptedOrg = organizationId;
      if (scenario === "wrong-organization") {
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
      if (scenario !== "missing-acceptance" && !legacy)
        await db.query(
          `INSERT INTO booking.pricing_quote_acceptances
        (id,property_id,organization_id,pricing_quote_id,guest_booking_id,command_receipt_id,request_id,key_hash,
         request_fingerprint_hash,quote_snapshot,disclosure_json,disclosure_hash,guest_policy_source_revision,
         acceptance_command,inventory_reservation_bundle,billing_plan_snapshot,commission_terms_snapshot,finance_terms_captured_at,accepted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'guest-policy:1',$13,$14,'fixed',$15,$16,'2026-09-01T00:02:00Z')`,
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
          ],
        );
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
      if (scenario === "released")
        await createTargetPmsInventoryReservationPort().release({
          propertyId,
          transaction: db,
          reservation: bundle,
          occurredAt: new Date("2026-09-01T00:03:00Z"),
        });
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
            "SELECT room_type_id,stay_date,available_count,blocked_count FROM pms.inventory_days WHERE property_id=$1 ORDER BY room_type_id,stay_date",
            [propertyId],
          )
        ).rows,
        blocks: (
          await db.query(
            "SELECT id,status,source_assignment_id,source_inventory_reservation_receipt_id FROM pms.room_blocks WHERE property_id=$1 ORDER BY id",
            [propertyId],
          )
        ).rows,
      });
      const before = await snapshot();
      const adopt = async () => {
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
              quote.stay.checkIn,
              quote.stay.checkOut,
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
      if (["complete", "legacy-initial", "legacy-amendment"].includes(scenario)) {
        await adopt();
        const after = await snapshot();
        expect(
          after.receipts.every(
            (r) => r.lifecycle_state === "handed_off" && r.lifecycle_revision === 2,
          ),
        ).toBe(true);
        expect(after.inventory).toEqual(before.inventory);
        expect(
          after.blocks.every(
            (b) => b.source_assignment_id && b.source_inventory_reservation_receipt_id === null,
          ),
        ).toBe(true);
        await db.query(
          "UPDATE pms.operational_booking_assignments SET updated_at=updated_at WHERE guest_booking_id=$1",
          [bookingId],
        );
        expect(await snapshot()).toEqual(after);
      } else if (scenario === "channel-without-room") {
        await adopt();
        expect(await snapshot()).toEqual(before);
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
      await db.end();
    }
  });
});
