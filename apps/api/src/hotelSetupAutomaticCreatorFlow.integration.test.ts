import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutomaticOwnerFlowFixture } from "./hotelSetupAutomaticOwnerFlow.fixture.js";

const databaseUrl = process.env.HOTEL_SETUP_AUTOMATIC_OWNER_FLOW_TEST_DATABASE_URL;
const rollbackRoot = process.env.HOTEL_SETUP_AUTOMATIC_ROLLBACK_PREFLIGHT_ROOT;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe.runIf(databaseUrl && rollbackRoot)("synthetic Creator-only native creation", () => {
  it("creates no PMS pending default or property-purpose credentials without a current PMS Owner link", async () => {
    const { admin, organizationId, actorUserId, creation, records, pass, close } =
      await createAutomaticOwnerFlowFixture(databaseUrl!, rollbackRoot!);
    try {
      await admin.query(
        "UPDATE hotel_catalog.organization_setup_track_intents SET selected_tracks=ARRAY['creator_marketplace'] WHERE organization_id=$1",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id=$1 AND product IN ('pms','booking')",
        [organizationId],
      );
      expect((await pass("organization")).receipts.map((r) => r.status)).toEqual(["provisioned"]);
      const input = {
        organizationId,
        idempotencyKey: "synthetic-creator-save",
        correlationId: "synthetic-creator-save",
        profile: {
          displayName: "Synthetic Creator hotel",
          propertyType: "hotel",
          location: {
            countryCode: "LK",
            city: "Fixture city",
            streetAddress: "",
            postalCode: "",
            timezone: "Asia/Colombo",
            latitude: null,
            longitude: null,
            localityPublic: false,
            geoPublic: false,
            mapDisplayMode: "hidden" as const,
          },
          contacts: [
            {
              channelType: "email" as const,
              value: "creator@fixture.invalid",
              purpose: "guest" as const,
              isPublic: false,
            },
          ],
        },
        audit: {
          actorUserId,
          requestId: "synthetic-creator-save",
          receivedAt: new Date().toISOString(),
        },
      };
      const saved = await creation.createPropertyProfile(input);
      expect(await creation.createPropertyProfile(input)).toEqual(saved);
      expect(
        (
          await admin.query(
            "SELECT product FROM identity.organization_resource_links WHERE organization_id=$1 AND resource_id=$2 ORDER BY product",
            [organizationId, saved.propertyId],
          )
        ).rows,
      ).toEqual([{ product: "hotel_catalog" }, { product: "marketplace" }]);
      expect(
        (
          await admin.query(
            "SELECT id FROM identity.product_entitlements WHERE organization_id=$1 AND entitlement_key='module:financials'",
            [organizationId],
          )
        ).rows,
      ).toEqual([]);
      expect((await pass("property")).receipts).toEqual([]);
      expect(records.size).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT database_login FROM platform.hotel_setup_property_scopes WHERE property_id=$1",
            [saved.propertyId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);
});
