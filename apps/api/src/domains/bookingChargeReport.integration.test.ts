import Fastify from "fastify";
import { registerBookingChargeReportRoutes } from "../routes/bookingChargeReports.js";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthorizationError } from "@vayada/backend-authorization";
import { context, databaseUrl, id, publicationFixture } from "./affiliatePublicationTestFixture.js";
import { submitBookingChargeReport } from "./bookingChargeReport.js";

const migration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0187_booking_charge_breakdown_reports.sql",
    import.meta.url,
  ),
  "utf8",
);
describe.skipIf(!databaseUrl)("native hotel charge report command", () => {
  const fixture = publicationFixture();
  const auth = () => ({
    ...context(),
    membership: { ...context().membership, permissions: ["booking.settings.manage" as const] },
    linkedResources: [
      {
        product: "booking" as const,
        resourceType: "booking_hotel" as const,
        resourceId: id(3),
        status: "active" as const,
        relationship: "owner" as const,
      },
    ],
    entitlements: [
      { product: "booking" as const, key: "booking-engine", status: "active" as const },
    ],
  });
  const input = () => ({
    propertyId: id(3),
    bookingId: id(50),
    sourceRevision: "r1",
    expectedReportId: null as string | null,
    reportedItemReference: "reported-room",
    components: { accommodation: "50000", tax: "5000", extras: "10000", other: "0" },
  });
  const runtime = () => ({
    freshContext: async () => auth(),
    environment: "local" as const,
    purpose: "diagnostic" as const,
    connectionReference: "native-test",
  });
  const submit = (
    value = input(),
    config: Parameters<typeof submitBookingChargeReport>[2] = runtime(),
  ) => submitBookingChargeReport(fixture.pool(), value, config);
  const count = async () =>
    (await fixture.pool().query("SELECT count(*)::int AS n FROM booking.charge_breakdown_reports"))
      .rows[0].n;
  beforeEach(async () => {
    await fixture.pool()
      .query(`UPDATE identity.organization_resource_links SET product='booking',resource_type='booking_hotel' WHERE id='${id(90)}';
      CREATE TABLE booking.guest_bookings(id UUID PRIMARY KEY,property_id UUID,edit_revision INT DEFAULT 0,room_count INT DEFAULT 1,booking_metadata JSONB DEFAULT '{}',currency TEXT DEFAULT 'EUR',quote_session_id UUID,total_amount NUMERIC(15,2),UNIQUE(id,property_id));
      CREATE TABLE booking.original_charge_snapshots(booking_id UUID PRIMARY KEY REFERENCES booking.guest_bookings(id),property_id UUID,quote_id UUID,contract_version TEXT,currency TEXT,totals JSONB,selected_offer JSONB);
      CREATE TABLE booking.affiliate_validation_booking_bindings(booking_id UUID);
      CREATE TABLE booking.affiliate_validation_quote_bindings(quote_id UUID);
      INSERT INTO booking.guest_bookings(id,property_id,quote_session_id,total_amount) VALUES('${id(50)}','${id(3)}','${id(51)}',650);
      INSERT INTO booking.original_charge_snapshots VALUES('${id(50)}','${id(3)}','${id(51)}','native-checkout-charge.v1','EUR',
        '{"currency":"EUR","roomTotal":"550","taxesAndFees":"0","addonTotal":"100","discounts":"0","promoDiscount":"0","totalAmount":"650"}','{}');`);
    await fixture.pool().query(migration);
  });
  it("serializes duplicates, detects changed payloads, and preserves corrections", async () => {
    const results = await Promise.all([submit(), submit()]);
    expect(results.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    const first = results[0];
    if (!first.ok) throw new Error("Expected report");
    expect(await count()).toBe(1);
    expect(
      await submit({
        ...input(),
        components: { ...input().components, tax: "4000", accommodation: "51000" },
      }),
    ).toMatchObject({ code: "idempotency_conflict" });
    expect(await submit({ ...input(), sourceRevision: "r2" })).toMatchObject({
      code: "revision_conflict",
    });
    const corrected = {
      ...input(),
      sourceRevision: "r2",
      expectedReportId: first.reportId,
      components: { ...input().components, tax: "4000", accommodation: "51000" },
    };
    expect(await submit(corrected)).toMatchObject({
      ok: true,
      status: "unverified",
      replayed: false,
    });
    expect(await submit(corrected)).toMatchObject({ ok: true, replayed: true });
    expect(await submit({ ...corrected, sourceRevision: "r3" })).toMatchObject({
      code: "revision_conflict",
    });
    expect(await count()).toBe(2);
  });
  it("rejects permission, entitlement and linked-resource denial including after lock acquisition", async () => {
    for (const field of ["permissions", "entitlements", "linkedResources"]) {
      for (const secondOnly of [false, true]) {
        let calls = 0;
        const config = {
          ...runtime(),
          freshContext: async () => {
            const c = auth();
            if (++calls === 2 || !secondOnly) {
              if (field === "permissions") c.membership.permissions = [];
              else if (field === "entitlements") c.entitlements = [];
              else c.linkedResources = [];
            }
            return c;
          },
        };
        await expect(submit(input(), config)).rejects.toBeInstanceOf(AuthorizationError);
      }
    }
    await submit(); // Revocation must also deny replay of an existing report.
    const suspended = {
      ...runtime(),
      freshContext: async () => ({
        ...auth(),
        actor: { ...auth().actor, status: "suspended" as const },
      }),
    };
    expect(await submit(input(), suspended)).toMatchObject({ code: "scope_unavailable" });
    await fixture.pool().query("UPDATE identity.organization_resource_links SET status='revoked'");
    expect(await submit()).toMatchObject({ code: "scope_unavailable" });
    expect(await count()).toBe(1);
  });
  it("rejects forged scope, unsupported sources, stale bookings and non-reconciling components", async () => {
    expect(await submit({ ...input(), bookingId: id(99) })).toMatchObject({
      code: "source_unavailable",
    });
    expect(
      await submit({ ...input(), components: { ...input().components, tax: "0.1" } }),
    ).toMatchObject({ code: "invalid_request" });
    expect(
      await submit({ ...input(), components: { ...input().components, tax: "5001" } }),
    ).toMatchObject({ code: "invalid_request" });
    for (const marker of ["lastHostEditPreviewId", "lastAcceptedChangeRequestId"]) {
      await fixture
        .pool()
        .query(
          "UPDATE booking.guest_bookings SET booking_metadata=jsonb_build_object($1::text,$2::text)",
          [marker, id(70)],
        );
      expect(await submit()).toMatchObject({ code: "source_unavailable" });
    }
    await fixture.pool().query("UPDATE booking.guest_bookings SET booking_metadata='{}'");
    await fixture.pool().query("UPDATE booking.guest_bookings SET edit_revision=1");
    expect(await submit()).toMatchObject({ code: "source_unavailable" });
    await fixture.pool().query("UPDATE booking.guest_bookings SET edit_revision=0,currency='JPY'");
    expect(await submit()).toMatchObject({ code: "source_unavailable" });
    expect(await count()).toBe(0);
  });
  it("does not promote diagnostic bookings through server live configuration", async () => {
    await fixture
      .pool()
      .query("INSERT INTO booking.affiliate_validation_booking_bindings VALUES($1)", [id(50)]);
    expect(
      await submit(input(), { ...runtime(), environment: "production", purpose: "live" }),
    ).toMatchObject({ code: "source_unavailable" });
    expect(await submit()).toMatchObject({ ok: true, status: "unverified" });
  });
  it("persists and replays an authorized HTTP report through the real command", async () => {
    const app = Fastify();
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      if (request.headers.authorization === "Bearer test") request.authContext = auth();
    });
    await app.register(registerBookingChargeReportRoutes, {
      refreshContext: async () => auth(),
      submit: (value, freshContext) =>
        submitBookingChargeReport(fixture.pool(), value, { ...runtime(), freshContext }),
    });
    try {
      const { components, reportedItemReference, expectedReportId } = input();
      const request = {
        method: "POST" as const,
        url: `/properties/${id(3)}/bookings/${id(50)}/charge-reports`,
        headers: { authorization: "Bearer test", "idempotency-key": "http-1" },
        payload: { components, reportedItemReference, expectedReportId },
      };
      const first = await app.inject(request),
        replay = await app.inject(request);
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        reportId: first.json().reportId,
        replayed: true,
        status: "unverified",
      });
      expect(await count()).toBe(1);
    } finally {
      await app.close();
    }
  });
  it("rolls failed insertion back and permits a clean retry", async () => {
    await fixture.pool()
      .query(`CREATE FUNCTION booking.fail_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected report failure'; END $$;
      CREATE TRIGGER fail_report AFTER INSERT ON booking.charge_breakdown_reports FOR EACH ROW EXECUTE FUNCTION booking.fail_report();`);
    await expect(submit()).rejects.toThrow("injected report failure");
    expect(await count()).toBe(0);
    await fixture.pool().query("DROP TRIGGER fail_report ON booking.charge_breakdown_reports");
    expect(await submit()).toMatchObject({ ok: true, replayed: false });
  });
});
