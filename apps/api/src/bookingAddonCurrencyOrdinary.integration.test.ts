import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgTargetBookingAddonItemsRepository,
  type CreateBookingAddonItemBody,
} from "./routes/bookingAddonItems.js";

const url = process.env.TEST_DATABASE_URL;

/**
 * Add-on prices use the PMS pricing currency (VAY-2141). Booking Admin reads its absence from
 * the list and asks the host to set it in setup instead of opening the editor.
 */
describe.skipIf(!url)("Booking add-on currency on the ordinary API login", () => {
  const admin = new pg.Client({ connectionString: url });
  let fixture: Awaited<ReturnType<typeof createHotelSetupOrdinaryLoginFixture>>;
  let pool: pg.Pool;
  const propertyId = randomUUID();
  const slug = `vay2141-${propertyId.slice(0, 8)}`;
  const transfer: CreateBookingAddonItemBody = {
    name: "Airport Transfer",
    description: "",
    price: "50.00",
    currency: "",
    category: "transport",
    imageMediaObjectId: null,
    duration: null,
    pricingModel: "per_stay",
    publicVisible: true,
    status: "active",
    sortOrder: 0,
    ownershipKind: "property",
    partnerCommissionRate: null,
  };

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
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$2,'VAY-2141')",
      [propertyId, slug],
    );
    // Booking Admin's own currency setting is a different store; it doesn't price add-ons.
    await admin.query(
      `INSERT INTO booking.booking_settings(property_id,default_currency,default_language,supported_languages,acceptance_mode)
       VALUES($1::uuid,'LKR','en',ARRAY['en'],'instant')`,
      [propertyId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "booking.addon_definitions",
      "pms.property_pricing_settings",
      "booking.booking_settings",
    ])
      await admin.query(`DELETE FROM ${table} WHERE property_id=$1::uuid`, [propertyId]);
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1::uuid", [propertyId]);
    await admin.query("COMMIT");
    await fixture?.drop();
    await admin.end();
  });

  it("has no currency and refuses add-ons until the pricing currency is set", async () => {
    const addons = createPgTargetBookingAddonItemsRepository({
      connectionString: fixture.connectionString,
      pool,
    });
    const listed = await addons.listAddonItemsByHotelId(propertyId);
    expect(listed).toMatchObject({ addonItems: [], propertyPlan: { propertyId } });
    expect(listed?.propertyCurrency).toBeUndefined();
    await expect(addons.createAddonItemByHotelId(propertyId, transfer)).rejects.toThrow(
      "Property pricing currency is unavailable.",
    );

    await admin.query(
      "INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES($1::uuid,'LKR')",
      [propertyId],
    );
    expect((await addons.listAddonItemsByHotelId(propertyId))?.propertyCurrency).toBe("LKR");
    await expect(addons.createAddonItemByHotelId(propertyId, transfer)).resolves.toMatchObject({
      outcome: "created",
    });
  });
});
