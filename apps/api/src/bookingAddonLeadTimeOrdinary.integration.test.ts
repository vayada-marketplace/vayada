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
 * VAY-2232: hosts pick an add-on's lead time from fixed choices, stored as
 * metadata.leadTimeHours. Saving a choice drops the free text older editors wrote; other saves
 * keep it until the data migration converts it.
 * VAY-2391: when the add-on happens, in the schedule_mode and bookable_weekdays columns.
 */
describe.skipIf(!url)("Booking add-on lead time and schedule on the ordinary API login", () => {
  const admin = new pg.Client({ connectionString: url });
  let fixture: Awaited<ReturnType<typeof createHotelSetupOrdinaryLoginFixture>>;
  let pool: pg.Pool;
  const propertyId = randomUUID();
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
  const metadata = async (id: string) =>
    (await admin.query("SELECT metadata FROM booking.addon_definitions WHERE id=$1::uuid", [id]))
      .rows[0].metadata as Record<string, unknown>;

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
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$2,'VAY-2232')",
      [propertyId, `vay2232-${propertyId.slice(0, 8)}`],
    );
    await admin.query(
      "INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES($1::uuid,'LKR')",
      [propertyId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of ["booking.addon_definitions", "pms.property_pricing_settings"])
      await admin.query(`DELETE FROM ${table} WHERE property_id=$1::uuid`, [propertyId]);
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1::uuid", [propertyId]);
    await admin.query("COMMIT");
    await fixture?.drop();
    await admin.end();
  });

  it("stores a fixed choice and replaces the old free text only when a choice is saved", async () => {
    const addons = createPgTargetBookingAddonItemsRepository({
      connectionString: fixture.connectionString,
      pool,
    });
    const created = await addons.createAddonItemByHotelId(propertyId, {
      ...transfer,
      leadTimeHours: 24,
    });
    if (created?.outcome !== "created") throw new Error("Add-on was not created");
    const id = created.addonItem.addonItemId;
    expect(created.addonItem).toMatchObject({ leadTimeHours: 24, leadTime: null });
    expect(await metadata(id)).toMatchObject({ leadTimeHours: 24 });
    expect(await metadata(id)).not.toHaveProperty("leadTime");

    // An add-on saved by the free-text editor before VAY-2232.
    await admin.query(
      `UPDATE booking.addon_definitions
       SET metadata = (metadata - 'leadTimeHours') || '{"leadTime":"10h"}' WHERE id=$1::uuid`,
      [id],
    );
    const listed = (await addons.listAddonItemsByHotelId(propertyId))?.addonItems;
    expect(listed).toMatchObject([{ addonItemId: id, leadTimeHours: null, leadTime: "10h" }]);

    // Saving other fields keeps the text for the migration. The answer is the saved add-on.
    await expect(
      addons.updateAddonItemByHotelId(propertyId, id, { price: "55.00" }),
    ).resolves.toMatchObject({ price: "55.00", leadTimeHours: null, leadTime: "10h" });
    expect(await metadata(id)).toMatchObject({ leadTime: "10h" });

    // A chosen lead time replaces it.
    await expect(
      addons.updateAddonItemByHotelId(propertyId, id, { leadTimeHours: 12 }),
    ).resolves.toMatchObject({ leadTimeHours: 12, leadTime: null });
    expect(await metadata(id)).not.toHaveProperty("leadTime");
    await expect(
      addons.updateAddonItemByHotelId(propertyId, id, { leadTimeHours: null }),
    ).resolves.toMatchObject({ leadTimeHours: null, leadTime: null });
    expect(await metadata(id)).toMatchObject({ leadTimeHours: null });

    // An older editor's empty text next to a choice changes nothing.
    await addons.updateAddonItemByHotelId(propertyId, id, { leadTimeHours: 48 });
    await expect(
      addons.updateAddonItemByHotelId(propertyId, id, { leadTime: null }),
    ).resolves.toMatchObject({ leadTimeHours: 48, leadTime: null });
    // Its typed text replaces the choice: the add-on is kept off the booking page, not opened.
    await expect(
      addons.updateAddonItemByHotelId(propertyId, id, { leadTime: "2 hours" }),
    ).resolves.toMatchObject({ leadTimeHours: null, leadTime: "2 hours" });
    expect(await metadata(id)).not.toHaveProperty("leadTimeHours");
  });

  it("stores when an add-on happens and keeps a per-night price every day (VAY-2391)", async () => {
    const addons = createPgTargetBookingAddonItemsRepository({
      connectionString: fixture.connectionString,
      pool,
    });
    const columns = async (id: string) =>
      (
        await admin.query(
          "SELECT schedule_mode, bookable_weekdays FROM booking.addon_definitions WHERE id=$1::uuid",
          [id],
        )
      ).rows[0];
    const every = [1, 2, 3, 4, 5, 6, 7];
    // Without a choice, transport happens on the arrival day.
    const created = await addons.createAddonItemByHotelId(propertyId, transfer);
    if (created?.outcome !== "created") throw new Error("Add-on was not created");
    const id = created.addonItem.addonItemId;
    const update = (body: Parameters<typeof addons.updateAddonItemByHotelId>[2]) =>
      addons.updateAddonItemByHotelId(propertyId, id, body);
    expect(created.addonItem).toMatchObject({ scheduleMode: "arrival", bookableWeekdays: every });
    expect(await columns(id)).toEqual({ schedule_mode: "arrival", bookable_weekdays: every });

    await expect(
      update({ scheduleMode: "guest_pick", bookableWeekdays: [6, 5] }),
    ).resolves.toMatchObject({ scheduleMode: "guest_pick", bookableWeekdays: [5, 6] });
    expect(await columns(id)).toEqual({ schedule_mode: "guest_pick", bookable_weekdays: [5, 6] });
    // A per-night price is every day; back on one price, the saved day no longer fits, so transport
    // happens on arrival again.
    await expect(update({ pricingModel: "per_night" })).resolves.toMatchObject({
      scheduleMode: "daily",
    });
    await expect(update({ pricingModel: "per_stay" })).resolves.toMatchObject({
      scheduleMode: "arrival",
      bookableWeekdays: [5, 6],
    });
    await expect(update({ scheduleMode: "daily" })).rejects.toThrow("per-night price");
    await expect(
      addons.createAddonItemByHotelId(propertyId, { ...transfer, scheduleMode: "daily" }),
    ).rejects.toThrow("per-night price");
    expect(await columns(id)).toEqual({ schedule_mode: "arrival", bookable_weekdays: [5, 6] });

    const breakfast = await addons.createAddonItemByHotelId(propertyId, {
      ...transfer,
      name: "Breakfast",
      category: "dining",
      pricingModel: "per_guest_night",
    });
    if (breakfast?.outcome !== "created") throw new Error("Add-on was not created");
    expect(breakfast.addonItem).toMatchObject({ scheduleMode: "daily", bookableWeekdays: every });
    const listed = (await addons.listAddonItemsByHotelId(propertyId))?.addonItems ?? [];
    expect(listed.find((addon) => addon.addonItemId === id)).toMatchObject({
      scheduleMode: "arrival",
    });
  });
});
