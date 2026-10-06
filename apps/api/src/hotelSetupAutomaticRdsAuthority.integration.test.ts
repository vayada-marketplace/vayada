import type { RequestContext } from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotelSetupCredentialResolver } from "./hotelSetupCommandCredentials.js";
import { createHotelSetupLaunchSettingsCommands } from "./hotelSetupLaunchSettingsCommands.js";
import { createAutomaticOwnerFlowFixture } from "./hotelSetupAutomaticOwnerFlow.fixture.js";
import { createRdsOperatorFixture } from "./hotelSetupAutomaticRdsOperator.fixture.js";
import type { SharedPropertyProfileInput } from "./routes/sharedHotelSetupStatus.js";

const databaseUrl = process.env.HOTEL_SETUP_AUTOMATIC_RDS_TEST_DATABASE_URL;
const rollbackRoot = process.env.HOTEL_SETUP_AUTOMATIC_ROLLBACK_PREFLIGHT_ROOT;
vi.setConfig({ testTimeout: 120_000 });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const settings = {
  defaultCurrency: "LKR",
  supportedCurrencies: ["LKR"],
  defaultLanguage: "en",
  supportedLanguages: ["en"],
  instagram: "",
  facebook: "",
  tiktok: "",
  youtube: "",
};
function firstSave(organizationId: string, actorUserId: string, key: string) {
  const profile: SharedPropertyProfileInput = {
    displayName: `TEST ONLY ${key}`,
    propertyType: "hotel",
    location: {
      countryCode: "LK",
      city: "Fixture city",
      streetAddress: "Fixture street 1",
      postalCode: "00000",
      timezone: "Asia/Colombo",
      latitude: null,
      longitude: null,
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: [
      { channelType: "email", value: "owner@fixture.invalid", purpose: "guest", isPublic: false },
    ],
    initialLaunchSettings: settings,
  };
  return {
    organizationId,
    idempotencyKey: key,
    correlationId: key,
    profile,
    audit: { actorUserId, requestId: key, receivedAt: new Date().toISOString() },
  };
}
function owner(organizationId: string, actorUserId: string) {
  return {
    actor: { internalUserId: actorUserId, providerIdentity: { sessionId: "synthetic-session" } },
    selectedOrganization: { organizationId },
    audit: { requestId: "synthetic-command", receivedAt: new Date().toISOString() },
  } as RequestContext;
}

/** Tear down both fixtures without masking the test's own failure. */
async function withRestrictedOperator(
  test: (
    rds: Awaited<ReturnType<typeof createRdsOperatorFixture>>,
    flow: Awaited<ReturnType<typeof createAutomaticOwnerFlowFixture>>,
  ) => Promise<void>,
) {
  const rds = await createRdsOperatorFixture(databaseUrl!);
  let flow: Awaited<ReturnType<typeof createAutomaticOwnerFlowFixture>> | undefined;
  const errors: unknown[] = [];
  try {
    flow = await createAutomaticOwnerFlowFixture(databaseUrl!, rollbackRoot!, rds);
    await test(rds, flow);
  } catch (error) {
    errors.push(error);
  }
  await rds.revokeOperator().catch((error: unknown) => errors.push(error));
  await flow?.close().catch((error: unknown) => errors.push(error));
  await rds.close().catch((error: unknown) => errors.push(error));
  if (errors.length) throw errors[0];
}

describe.runIf(databaseUrl && rollbackRoot)(
  "automatic setup under the inspected RDS operator authority",
  () => {
    it("provisions, replays and admits only proved credentials without catalog or RLS bypass", async () => {
      await withRestrictedOperator(async (rds, flow) => {
        const { organizationId, actorUserId, options, creation, records, pass } = flow;
        expect((await pass("organization")).receipts.map((r) => r.status)).toEqual(["provisioned"]);
        const { propertyId } = await creation.createPropertyProfile(
          firstSave(organizationId, actorUserId, "rds-first-save"),
        );
        await expect(
          createHotelSetupCredentialResolver(options, "launch_settings")(
            propertyId,
            organizationId,
          ),
        ).rejects.toThrow();
        expect((await pass("property")).receipts.map((r) => r.status)).toEqual([
          "provisioned",
          "provisioned",
          "provisioned",
        ]);
        expect(records.size).toBe(4);
        const ready = async () =>
          (
            await rds.su.query(
              `SELECT database_login,credential_role_oid,credential_secret_version FROM platform.hotel_setup_creation_scopes
               WHERE organization_id=$1 UNION ALL SELECT database_login,credential_role_oid,credential_secret_version
               FROM platform.hotel_setup_property_scopes WHERE property_id=$2 ORDER BY 1`,
              [organizationId, propertyId],
            )
          ).rows;
        const before = await ready();
        expect(before).toHaveLength(4);
        await pass("organization");
        await pass("property");
        await pass("property");
        expect(await ready()).toEqual(before);
        expect(records.size).toBe(4);
        expect(
          await createHotelSetupLaunchSettingsCommands(options).updateLaunchSettings(
            owner(organizationId, actorUserId),
            propertyId,
            settings,
          ),
        ).toEqual(settings);
        // Production RDS shape: no creator edge, superuser-recorded parent edge, owner helper grants.
        expect(await rds.nativeMembership()).toEqual(
          before.map(({ database_login }) => ({
            login: database_login,
            incoming: 0,
            parents: 1,
            grantor_super: true,
          })),
        );
        expect(rds.operations.catalog).toBe(0);
        expect(rds.operations.borrowed).toBe(12);
      });
    });
  },
);
