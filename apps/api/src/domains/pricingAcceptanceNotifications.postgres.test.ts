import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { replacementStayKey } from "@vayada/domain-booking";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { stagePricingAcceptanceNotifications } from "./pricingAcceptanceNotifications.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
// Real existing email events/jobs/audit and immutable history; prior acceptance
// and public authority are fixtures. No worker or provider is run; all rolls back.
describe.skipIf(!url)("replacement acceptance notification staging", () => {
  it.each(["success", "missing-host", "wrong-guest", "wrong-total", "authority-lost"])(
    "stages safely: %s",
    async (scenario) => {
      if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
        throw new Error("test database required");
      const db = new pg.Client({ connectionString: url });
      await db.connect();
      const base = acceptanceFixture(),
        propertyId = randomUUID(),
        orgId = randomUUID(),
        bookingId = randomUUID();
      const f = pricingDraftFixture((q) => {
        Object.assign(q, { quoteId: randomUUID() });
        Object.assign(q.stay, { propertyId });
        Object.assign(q.evidence, { requestKey: replacementStayKey(q.stay) });
      });
      const { fingerprint, ...command } = f.command;
      const row = {
        ...base,
        id: randomUUID(),
        property_id: propertyId,
        organization_id: orgId,
        pricing_quote_id: f.current.quote.quoteId,
        guest_booking_id: bookingId,
        command_receipt_id: randomUUID(),
        quote_snapshot: f.current.quote,
        disclosure_json: f.disclosure.disclosureJson,
        disclosure_hash: f.disclosure.policy.disclosureHash,
        acceptance_command: command,
        request_fingerprint_hash: fingerprint.slice(7),
      };
      vi.mocked(lockPublicPricingAuthority)
        .mockReset()
        .mockResolvedValue({ ...f.current.scope, propertyId, organizationId: orgId });
      const accepted = { bookingId, acceptanceId: row.id, acceptedAt: row.accepted_at };
      try {
        await db.query("BEGIN");
        await db.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Synthetic notifications',($1::uuid)::text)",
          [orgId],
        );
        await db.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic notifications')",
          [propertyId],
        );
        if (scenario !== "missing-host")
          await db.query(
            "INSERT INTO hotel_catalog.property_contact_channels(property_id,channel_type,value,source_system,purpose) VALUES($1,'email','host@example.test','platform','operations')",
            [propertyId],
          );
        await db.query(
          `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            row.pricing_quote_id,
            propertyId,
            orgId,
            row.request_id,
            row.key_hash,
            { quote: row.quote_snapshot },
          ],
        );
        await db.query(
          `INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,lifecycle_status,payment_status,
        check_in,check_out,adults,children,room_count,currency,total_amount,balance_amount,expected_payment_method,booking_metadata)
        VALUES($1,$2,$3,'booking','confirmed','unpaid','2026-10-01','2026-10-03',2,1,1,'EUR',$4,360,'pay_at_property',$5)`,
          [
            bookingId,
            propertyId,
            `VAY-${bookingId.replaceAll("-", "").toUpperCase()}`,
            scenario === "wrong-total" ? 999 : 360,
            {
              targetSource: "pricing_quote_draft",
              pricingQuoteId: row.pricing_quote_id,
              requestFingerprint: fingerprint,
              paymentMethod: "pay_at_property",
            },
          ],
        );
        await db.query(
          "INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email) VALUES($1,'booker','Jane','Guest',$2)",
          [bookingId, scenario === "wrong-guest" ? "other@example.test" : command.guest.email],
        );
        await db.query(
          `INSERT INTO platform.idempotency_keys(id,operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
        expires_at,completed_at,response_status_code,response_resource_product,response_resource_type,response_resource_id)
        VALUES($1,'booking','booking.pricing_quote.accept',$2,$3,'completed','property',$4,clock_timestamp()+interval '90 days',clock_timestamp(),200,'booking','guest_booking',$5)`,
          [
            row.command_receipt_id,
            row.key_hash,
            row.request_fingerprint_hash,
            propertyId,
            bookingId,
          ],
        );
        const keys = Object.keys(row);
        await db.query(
          `INSERT INTO booking.pricing_quote_acceptances(${keys.join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          Object.values(row),
        );
        if (scenario === "authority-lost")
          vi.mocked(lockPublicPricingAuthority)
            .mockResolvedValueOnce({ ...f.current.scope, propertyId, organizationId: orgId })
            .mockResolvedValue(null);
        const run = () =>
          stagePricingAcceptanceNotifications(db as unknown as PoolClient, "hotel", accepted);
        if (["success", "missing-host"].includes(scenario)) {
          const result = await run();
          expect(result.jobs).toHaveLength(scenario === "success" ? 2 : 1);
          const retry = await run();
          expect(retry.jobs.every((job) => job.status === "idempotent_replay")).toBe(true);
          const jobs = (
            await db.query("SELECT payload FROM platform.jobs WHERE property_id=$1", [propertyId])
          ).rows;
          const guest = jobs.find((j) => j.payload.recipientRole === "guest")!.payload;
          expect(guest.to).toBe(command.guest.email);
          expect(guest.text).toContain("Total: 360.00 EUR");
          expect(guest.text).toContain("Balance: 360.00 EUR");
          expect(guest.text).toContain("Rooms: 1");
          expect(guest.text).not.toContain("paid in full");
          expect(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM platform.domain_events WHERE property_id=$1",
                [propertyId],
              )
            ).rows[0].n,
          ).toBe(jobs.length);
          expect(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM platform.product_audit_events WHERE property_id=$1",
                [propertyId],
              )
            ).rows[0].n,
          ).toBe(2);
        } else {
          await expect(run()).rejects.toThrow("unavailable");
          expect(
            (
              await db.query("SELECT count(*)::int AS n FROM platform.jobs WHERE property_id=$1", [
                propertyId,
              ])
            ).rows[0].n,
          ).toBe(scenario === "wrong-total" ? 0 : 2);
        }
        await db.query("ROLLBACK");
        for (const table of ["jobs", "domain_events", "product_audit_events"])
          expect(
            (
              await db.query(
                `SELECT count(*)::int AS n FROM platform.${table} WHERE property_id=$1`,
                [propertyId],
              )
            ).rows[0].n,
          ).toBe(0);
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM booking.pricing_quote_acceptances WHERE id=$1",
              [row.id],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await db.query("ROLLBACK");
        await db.end();
      }
    },
  );
});
