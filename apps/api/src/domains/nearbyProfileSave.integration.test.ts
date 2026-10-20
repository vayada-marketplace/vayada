import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgTargetBookingSettingsRepository } from "../routes/bookingSettings.js";
import { createPgPropertyNearbyDiscoveryRepository } from "./propertyNearbyDiscoveryRepository.js";
import { createPgPropertyNearbyRepository } from "./propertyNearbyRepository.js";
import { createPgPublicNearbyRepository } from "./publicNearbyRepository.js";

// VAY-2104: a Booking Admin Property save that leaves the map pin alone keeps the hotel's nearby
// picks and the current Google lookup. Committed rows, because the settings save opens its own
// transaction; afterAll removes everything this property wrote.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("nearby picks across Property saves", () => {
  const admin = new pg.Client({ connectionString: url });
  const nearby = createPgPublicNearbyRepository(url ?? "disabled");
  const curation = createPgPropertyNearbyRepository(url ?? "disabled");
  const discovery = createPgPropertyNearbyDiscoveryRepository(url ?? "disabled");
  const settings = createPgTargetBookingSettingsRepository({ connectionString: url ?? "disabled" });
  const propertyId = randomUUID(),
    organizationId = randomUUID(),
    userId = randomUUID(),
    revisionId = randomUUID();
  const scope = { propertyId, organizationId, actorUserId: userId, requestId: randomUUID() };
  const favorite = {
    placeId: "cafe",
    category: "food" as const,
    hidden: false,
    favorite: true,
    added: false,
    note: "Best coffee",
  };
  const custom = {
    id: randomUUID(),
    name: "Our beach",
    category: "nature" as const,
    address: "Beach road",
    latitude: -1.1,
    longitude: 1.1,
    favorite: true,
    hidden: false,
    note: "Our favorite",
  };
  const revision = async () =>
    Number(
      (
        await admin.query("SELECT profile_revision FROM hotel_catalog.properties WHERE id=$1", [
          propertyId,
        ])
      ).rows[0].profile_revision,
    );
  const guestPlaces = async () =>
    (await nearby.read(propertyId))!.public.places.map((place) => [
      place.source,
      place.favorite,
      place.note,
    ]);

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Test database required");
    await admin.connect();
    const q = (sql: string, values: unknown[]) => admin.query(sql, values);
    await q(
      "INSERT INTO identity.users(id,email,name,status) VALUES ($1,$1::uuid::text || '@example.test','Nearby','active')",
      [userId],
    );
    await q(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES ($1,'hotel_group','Nearby',$1::uuid::text)",
      [organizationId],
    );
    await q(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status) VALUES ($1,$1::uuid::text,'Nearby','active')",
      [propertyId],
    );
    for (const [product, type] of [
      ["hotel_catalog", "property"],
      ["booking", "booking_hotel"],
    ])
      await q(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES ($1,$2,$3,$4,'owner','active')",
        [organizationId, product, type, propertyId],
      );
    await q(
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES ($1,'booking','booking-engine','active')",
      [organizationId],
    );
    await q(
      "INSERT INTO hotel_catalog.property_locations(property_id,latitude,longitude,geo_public,map_display_mode) VALUES ($1,-1.125,1.005,true,'approximate')",
      [propertyId],
    );
    await q(
      `INSERT INTO distribution.public_booking_content_revisions
      (id,property_id,revision_number,readiness_contract_version,source_manifest,source_manifest_hash,readiness_hash,readiness_product,readiness_status,public_content,built_by_user_id)
      VALUES ($1,$2,1,'onboarding-product-readiness.v1',$3,$4,$4,'booking','ready','{}',$5)`,
      [
        revisionId,
        propertyId,
        JSON.stringify({
          contractVersion: "onboarding-source-manifest.v1",
          propertyId,
          sources: [{}],
        }),
        `sha256:${"1".repeat(64)}`,
        userId,
      ],
    );
    await q(
      "INSERT INTO distribution.active_public_booking_revision(property_id,content_revision_id,activated_by_user_id) VALUES ($1,$2,$3)",
      [propertyId, revisionId, userId],
    );
    // The host's lookup and picks, saved through the same repositories as the editor.
    const claim = await discovery.claim(scope, await revision());
    if (claim.status !== "claimed") throw new Error("Claim required");
    await discovery.complete(scope, claim.token, claim.profileRevision, {
      status: "ready",
      places: [{ placeId: "cafe", category: "food", latitude: -1.12, longitude: 1.0 }],
    });
    const saved = await curation.save(scope, {
      schemaVersion: 1,
      expectedProfileRevision: await revision(),
      expectedCurationRevision: 0,
      choices: [favorite],
      customPlaces: [custom],
    });
    if (!saved.ok) throw new Error(`Curation save failed: ${saved.code}`);
  });

  afterAll(async () => {
    await Promise.all([nearby.close(), curation.close(), discovery.close(), settings.close?.()]);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role=replica");
    const tables = await admin.query<{ name: string }>(
      `SELECT format('%I.%I', c.table_schema, c.table_name) AS name
       FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.column_name='property_id' AND t.table_type='BASE TABLE'
         AND c.table_schema IN ('hotel_catalog','booking','distribution','pms')`,
    );
    for (const { name } of tables.rows)
      await admin.query(`DELETE FROM ${name} WHERE property_id::text=$1`, [propertyId]);
    await admin.query("DELETE FROM platform.product_audit_events WHERE organization_id=$1", [
      organizationId,
    ]);
    await admin.query("DELETE FROM identity.product_entitlements WHERE organization_id=$1", [
      organizationId,
    ]);
    await admin.query("DELETE FROM identity.organization_resource_links WHERE organization_id=$1", [
      organizationId,
    ]);
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    await admin.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
    await admin.query("DELETE FROM identity.users WHERE id=$1", [userId]);
    await admin.query("COMMIT");
    await admin.end();
  });

  it("keeps picks, notes, own places and the lookup after a phone-number-only save", async () => {
    expect(await guestPlaces()).toEqual([
      ["google", true, "Best coffee"],
      ["custom", true, "Our favorite"],
    ]);
    const before = await revision();
    const saved = await settings.updatePropertySettingsByHotelId!(
      propertyId,
      { phoneNumber: "+41 44 000 00 00" },
      organizationId,
    );
    expect(saved).not.toBeNull();
    const after = await revision();
    expect(after).toBeGreaterThan(before);

    const guest = await nearby.read(propertyId);
    expect(guest).toMatchObject({ needsRefresh: false, public: { status: "ready" } });
    expect(await guestPlaces()).toEqual([
      ["google", true, "Best coffee"],
      ["custom", true, "Our favorite"],
    ]);
    // The editor shows the picks as confirmed (no "reconfirm") and reuses the lookup.
    expect(await curation.read(scope)).toMatchObject({
      profileRevision: after,
      savedProfileRevision: after,
      choices: [favorite],
    });
    expect(await discovery.claim(scope, after)).toMatchObject({
      status: "state",
      state: { status: "ready", profileRevision: after },
    });
    expect(
      await curation.save(scope, {
        schemaVersion: 1,
        expectedProfileRevision: after,
        expectedCurationRevision: 1,
        choices: [{ ...favorite, note: "Still the best coffee" }],
        customPlaces: [custom],
      }),
    ).toMatchObject({ ok: true, state: { savedProfileRevision: after } });
  });

  it("follows the public pin through map-mode switches; older rows keep the revision rule", async () => {
    const bump = () =>
      admin.query(
        "UPDATE hotel_catalog.properties SET profile_revision=profile_revision+1 WHERE id=$1",
        [propertyId],
      );
    const mode = async (value: string) => {
      await admin.query(
        "UPDATE hotel_catalog.property_locations SET map_display_mode=$2 WHERE property_id=$1",
        [propertyId, value],
      );
      await bump();
    };
    const confirmed = async () => {
      const state = await curation.read(scope);
      return state?.savedProfileRevision === state?.profileRevision;
    };
    // Exact shows guests a different point (-1.125 vs -1.13): reconfirm and a new lookup.
    await mode("exact");
    expect(await confirmed()).toBe(false);
    expect(await discovery.read(scope)).toMatchObject({ status: "stale" });
    // Back to approximate is the same public point again.
    await mode("approximate");
    expect(await confirmed()).toBe(true);
    expect(await discovery.read(scope)).toMatchObject({ status: "ready" });
    // Rows saved before VAY-2104 have no origin and count only at their own revision.
    const saved = await admin.query(
      `SELECT c.saved_origin, d.origin FROM hotel_catalog.property_nearby_curation c
       JOIN hotel_catalog.property_nearby_discovery d USING (property_id) WHERE property_id=$1`,
      [propertyId],
    );
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_curation SET saved_origin=NULL WHERE property_id=$1",
      [propertyId],
    );
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET origin=NULL WHERE property_id=$1",
      [propertyId],
    );
    expect(await confirmed()).toBe(false);
    expect(await nearby.read(propertyId)).toMatchObject({
      needsRefresh: true,
      public: { places: [] },
    });
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_curation SET saved_origin=$2 WHERE property_id=$1",
      [propertyId, saved.rows[0].saved_origin],
    );
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET origin=$2 WHERE property_id=$1",
      [propertyId, saved.rows[0].origin],
    );
    expect(await confirmed()).toBe(true);
  });

  it("still asks for a new lookup and a reconfirm once the pin moves", async () => {
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET latitude=-1.3 WHERE property_id=$1",
      [propertyId],
    );
    await admin.query(
      "UPDATE hotel_catalog.properties SET profile_revision=profile_revision+1 WHERE id=$1",
      [propertyId],
    );
    const moved = await revision();
    expect(await nearby.read(propertyId)).toMatchObject({
      needsRefresh: true,
      public: { status: "unavailable", places: [] },
    });
    const state = await curation.read(scope);
    expect(state?.profileRevision).toBe(moved);
    expect(state?.savedProfileRevision).toBeLessThan(moved);
    expect(await discovery.read(scope)).toMatchObject({ status: "stale", places: [] });
  });
});
