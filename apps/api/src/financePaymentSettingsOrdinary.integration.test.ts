import { randomUUID } from "node:crypto";
import type { FinanceRoutePaymentMethod } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { createTargetFinancePropertySettingsRepository } from "./routes/finance.js";

const url = process.env.TEST_DATABASE_URL;

/**
 * Booking Admin → Settings → Payments on the ordinary API login (VAY-2185). The page re-sends
 * Cash + Card once when Finance answers plain Pay at Hotel with this exact message.
 */
describe.skipIf(!url)("Booking Admin payment settings on the ordinary API login", () => {
  const admin = new pg.Client({ connectionString: url });
  let fixture: Awaited<ReturnType<typeof createHotelSetupOrdinaryLoginFixture>>;
  let pool: pg.Pool;
  const [organizationId, propertyId, owner] = [randomUUID(), randomUUID(), randomUUID()];
  const slug = `vay2185-${propertyId.slice(0, 8)}`;

  beforeAll(async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    await admin.connect();
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 2 });
    await admin.query(
      "INSERT INTO identity.users(id,email,name,status) VALUES($1::uuid,$2,'VAY-2185','active')",
      [owner, `${slug}@example.test`],
    );
    await admin.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','VAY-2185',$2)",
      [organizationId, slug],
    );
    await admin.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$2,'VAY-2185')",
      [propertyId, slug],
    );
    // An imported hotel: booking settings carry its currency; no PMS price currency yet.
    await admin.query(
      `INSERT INTO booking.booking_settings(property_id,default_currency,default_language,supported_languages,acceptance_mode)
       VALUES($1::uuid,'LKR','en',ARRAY['en'],'instant')`,
      [propertyId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    // Same cleanup as financePaymentWriters: the save's audit, outbox and idempotency rows too.
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "platform.product_audit_events",
      "platform.outbox_events",
      "platform.domain_events",
      "platform.idempotency_keys",
      "finance.payment_settings",
      "booking.booking_settings",
    ])
      await admin.query(`DELETE FROM ${table} WHERE property_id=$1::uuid`, [propertyId]);
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1::uuid", [propertyId]);
    await admin.query("DELETE FROM identity.organizations WHERE id=$1::uuid", [organizationId]);
    await admin.query("DELETE FROM identity.users WHERE id=$1::uuid", [owner]);
    await admin.query("COMMIT");
    await fixture?.drop();
    await admin.end();
  });

  function save(acceptedMethods: FinanceRoutePaymentMethod[]) {
    const settings = createTargetFinancePropertySettingsRepository({
      connectionString: fixture.connectionString,
      pool,
    });
    return settings.updatePaymentSettings!({
      commandType: "finance.payment_settings.update",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId,
      audit: {
        actor: { kind: "user", userId: owner, organizationId },
        requestId: randomUUID(),
        correlationId: randomUUID(),
        reason: "Payments saved from Booking Admin",
        requestedAt: new Date().toISOString(),
      },
      payload: { paymentsEnabled: true, acceptedMethods },
    });
  }

  it("names the missing Cash/Card choice, then saves Pay at Hotel with both", async () => {
    await expect(save(["pay_at_property"])).resolves.toMatchObject({
      ok: false,
      statusCode: 400,
      message: "Pay at Hotel requires cash, card, or both.",
    });
    await expect(save(["pay_at_property", "cash", "manual_card"])).resolves.toMatchObject({
      ok: true,
      settings: {
        acceptedMethods: ["pay_at_property", "cash", "manual_card"],
        defaultCurrency: "LKR",
      },
    });
  });
});
