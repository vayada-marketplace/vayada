import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { parsePmsInventoryReservationBundle } from "@vayada/domain-pms";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { storePricingAcceptance } from "./storePricingAcceptance.js";
import { replayPricingAcceptance } from "./pricingAcceptanceReplay.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import {
  PMS_ACCEPTED_PRICING_JOB_TYPE,
  stagePmsAcceptedPricingReservationJob,
} from "./pricingPmsAcceptedReservationJob.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
// Real receipt/history/replay SQL and constraints. Prior staging and owner
// results are fixtures, not proof of a complete acceptance orchestration.
describe.skipIf(!url)("pricing acceptance persistence PostgreSQL", () => {
  it.each([
    "success",
    "receipt-conflict",
    "wrong-booking",
    "expired",
    "authority-lost",
    "stored-quote-conflict",
  ])("stores atomically: %s", async (scenario) => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    vi.resetAllMocks();
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    const propertyId = randomUUID(),
      orgId = randomUUID(),
      bookingId = randomUUID(),
      receiptId = randomUUID();
    try {
      await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const f = pricingDraftFixture((q) => {
        Object.assign(q, { quoteId: randomUUID() });
        Object.assign(q.stay, { propertyId });
        Object.assign(q.evidence, {
          requestKey: replacementStayKey(q.stay),
          issuedAt: new Date(now.getTime() - 60000).toISOString(),
          expiresAt: new Date(now.getTime() + (scenario === "expired" ? -1 : 600000)).toISOString(),
        });
      });
      Object.assign(f.current.scope, { propertyId, organizationId: orgId });
      const quote = f.current.quote,
        finance = f.finance;
      const prepared = {
        kind: "fresh" as const,
        current: f.current,
        disclosure: f.disclosure,
        command: f.command,
        finance,
        commandReceiptId: receiptId,
      };
      const bundle = parsePmsInventoryReservationBundle(
        acceptanceFixture().inventory_reservation_bundle,
      )!;
      const lifecycle = {
        bookingId,
        lifecycleStatus: "confirmed",
        hostResponseDeadlineAt: null,
        occurredAt: now.toISOString(),
        inventoryReservation: bundle,
      };
      vi.mocked(lockPublicPricingAuthority).mockResolvedValue(f.current.scope);
      await db.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Synthetic acceptance',($1::uuid)::text)",
        [orgId],
      );
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic acceptance')",
        [propertyId],
      );
      await db.query(
        `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          quote.quoteId,
          propertyId,
          orgId,
          f.command.requestId,
          hash(f.command.requestId),
          { quote },
        ],
      );
      await db.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,lifecycle_status,payment_status,
        check_in,check_out,currency,total_amount,balance_amount,billing_plan_snapshot,commission_terms_snapshot,finance_terms_captured_at,booking_metadata)
        VALUES($1,$2,$3,'booking','confirmed','unpaid',$4,$5,'EUR',360,360,$6,$7,$8,$9)`,
        [
          bookingId,
          propertyId,
          `VAY-${bookingId.replaceAll("-", "").toUpperCase()}`,
          quote.stay.checkIn,
          quote.stay.checkOut,
          finance.billingPlanSnapshot,
          finance.commissionTermsSnapshot,
          finance.financeTermsCapturedAt,
          {
            targetSource: "pricing_quote_draft",
            pricingQuoteId: quote.quoteId,
            requestFingerprint: f.command.fingerprint,
            pricingSelections: quote.stay.rooms,
            inventoryReservation: bundle,
          },
        ],
      );
      await db.query(
        `INSERT INTO platform.idempotency_keys(id,operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,expires_at)
        VALUES($1,'booking','booking.pricing_quote.accept',$2,$3,'in_progress','property',$4,clock_timestamp()+interval '90 days')`,
        [
          receiptId,
          hash(f.command.requestId),
          scenario === "receipt-conflict" ? "a".repeat(64) : f.command.fingerprint.slice(7),
          propertyId,
        ],
      );
      if (scenario === "wrong-booking")
        await db.query(
          "UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,'{pricingQuoteId}',to_jsonb($2::text)) WHERE id=$1",
          [bookingId, randomUUID()],
        );
      if (scenario === "authority-lost")
        vi.mocked(lockPublicPricingAuthority)
          .mockReset()
          .mockResolvedValueOnce(f.current.scope)
          .mockResolvedValue(null);
      if (scenario === "stored-quote-conflict") {
        Object.assign(quote, { evaluatorVersion: "changed" });
        Object.assign(f.disclosure.quote, { evaluatorVersion: "changed" });
      }
      const client = db as unknown as PoolClient;
      const run = () =>
        storePricingAcceptance(client, "hotel", prepared, lifecycle, {
          bookingId,
          roomNights: 2,
        });
      if (scenario === "success") {
        const result = await run();
        expect(result.bookingId).toBe(bookingId);
        const stored = (
          await db.query("SELECT * FROM booking.pricing_quote_acceptances WHERE id=$1", [
            result.acceptanceId,
          ])
        ).rows[0];
        expect(stored.quote_snapshot).toEqual(quote);
        expect(stored.disclosure_json).toBe(f.disclosure.disclosureJson);
        expect(stored.inventory_reservation_bundle).toEqual(bundle);
        expect(stored.commission_terms_snapshot).toEqual(finance.commissionTermsSnapshot);
        expect(stored.accepted_at.toISOString()).toBe(result.acceptedAt);
        const staged = await stagePmsAcceptedPricingReservationJob(client, "hotel", result);
        expect(await stagePmsAcceptedPricingReservationJob(client, "hotel", result)).toEqual(
          staged,
        );
        expect(
          (
            await db.query(
              `SELECT queue_name,job_type,resource_product,resource_type,resource_id,
                payload->>'version' AS version,payload->>'acceptanceId' AS acceptance,
                payload->>'guestBookingId' AS booking,payload->>'propertyId' AS property
               FROM platform.jobs WHERE id=$1`,
              [staged.jobId],
            )
          ).rows,
        ).toEqual([
          {
            queue_name: "pms-reservation-handoff",
            job_type: PMS_ACCEPTED_PRICING_JOB_TYPE,
            resource_product: "booking",
            resource_type: "guest_booking",
            resource_id: bookingId,
            version: "booking.pricing-pms-handoff.v1",
            acceptance: result.acceptanceId,
            booking: bookingId,
            property: propertyId,
          },
        ]);
        await db.query("UPDATE platform.jobs SET resource_type='wrong_booking' WHERE id=$1", [
          staged.jobId,
        ]);
        await expect(
          stagePmsAcceptedPricingReservationJob(client, "hotel", result),
        ).rejects.toThrow("PMS accepted-pricing job conflict");
        const { fingerprint, ...input } = f.command;
        void fingerprint;
        expect(await replayPricingAcceptance(client, "hotel", input)).toEqual({
          bookingId,
          replayed: true,
        });
        await expect(run()).rejects.toThrow("unavailable");
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM booking.pricing_quote_acceptances WHERE guest_booking_id=$1",
              [bookingId],
            )
          ).rows[0].n,
        ).toBe(1);
      } else if (scenario === "stored-quote-conflict") {
        await expect(run()).rejects.toMatchObject({ code: "P0001" });
      } else {
        await expect(run()).rejects.toThrow("unavailable");
        const late = ["expired", "authority-lost"].includes(scenario);
        expect(
          (await db.query("SELECT status FROM platform.idempotency_keys WHERE id=$1", [receiptId]))
            .rows[0].status,
        ).toBe(late ? "completed" : "in_progress");
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM booking.pricing_quote_acceptances WHERE guest_booking_id=$1",
              [bookingId],
            )
          ).rows[0].n,
        ).toBe(late ? 1 : 0);
      }
      await db.query("ROLLBACK");
      expect(
        (
          await db.query("SELECT count(*)::int AS n FROM platform.idempotency_keys WHERE id=$1", [
            receiptId,
          ])
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM booking.pricing_quote_acceptances WHERE guest_booking_id=$1",
            [bookingId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.query("SELECT count(*)::int AS n FROM booking.guest_bookings WHERE id=$1", [
            bookingId,
          ])
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.query("ROLLBACK");
      await db.end();
    }
  });
});
