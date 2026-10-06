import { createHash } from "node:crypto";
import { CreateSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import {
  createHotelSetupCreationCredentialResolver,
  createHotelSetupCredentialResolver,
} from "./hotelSetupCommandCredentials.js";
import { hotelSetupOrganizationRolePrefix } from "./hotelSetupOrganizationRoleStaging.js";
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

const faults = [
  "stagingRollback",
  "stagingCommitLost",
  "activationCommitLost",
  "rollbackProof",
  "publication",
  "publicationLost",
  "readback",
  "revokedBeforeReady",
  "readinessCommitLost",
] as const;
type Fault = (typeof faults)[number];
/** A's receipts per pass, A's new secrets and whether A's target is finally admitted. */
type Outcome = {
  first: string[];
  replay: string[];
  settled: string[];
  secrets: number;
  ready: boolean;
};
const pending = (secrets: number): Outcome => ({
  first: ["inspection_required"],
  replay: ["inspection_required"],
  settled: ["inspection_required"],
  secrets,
  ready: false,
});
// Property passes prepare launch_settings first; A's other two purposes are independent.
const property = (outcome: Outcome, later = "provisioned"): Outcome => ({
  ...outcome,
  first: [...outcome.first, later, later],
  replay: outcome.replay.length ? [...outcome.replay, "existing_ready", "existing_ready"] : [],
  settled: outcome.settled.length ? [...outcome.settled, "existing_ready", "existing_ready"] : [],
  secrets: outcome.secrets + (later === "provisioned" ? 2 : 0),
});
const outcomes: Record<Fault, Record<"organization" | "property", Outcome>> = Object.fromEntries(
  faults.map((fault) => {
    // Nothing durable before a lost-before-COMMIT staging failure, so only it may retry.
    const organization: Outcome =
      fault === "stagingRollback"
        ? {
            first: ["inspection_required"],
            replay: ["provisioned"],
            settled: ["existing_ready"],
            secrets: 1,
            ready: true,
          }
        : fault === "revokedBeforeReady"
          ? { first: ["inspection_required"], replay: [], settled: [], secrets: 1, ready: false }
          : fault === "readinessCommitLost"
            ? {
                first: ["inspection_required"],
                replay: ["existing_ready"],
                settled: ["existing_ready"],
                secrets: 1,
                ready: true,
              }
            : pending(["publicationLost", "readback"].includes(fault) ? 1 : 0);
    return [
      fault,
      {
        organization,
        property: property(
          organization,
          fault === "revokedBeforeReady" ? "pending_authority" : "provisioned",
        ),
      },
    ];
  }),
) as never;

function propertyRolePrefix(propertyId: string, purpose: string) {
  const hash = createHash("sha256").update(`${propertyId}:${purpose}`).digest("hex");
  return `vayada_next_hotel_setup_property_${hash.slice(0, 16)}_`;
}

/** Injects one fault into hotel A's target scope only; executed SQL stays real. */
function installFault(
  rds: Awaited<ReturnType<typeof createRdsOperatorFixture>>,
  flow: Awaited<ReturnType<typeof createAutomaticOwnerFlowFixture>>,
  fault: Fault,
  target: () => string,
  organizationId: string,
  actorUserId: string,
) {
  let fired = false;
  const once = (matches: boolean) => (!fired && matches ? (fired = true) : false);
  const transactions = new WeakMap<pg.Client, string[]>();
  const kind = (statements: string[]) =>
    statements.some((sql) => sql.startsWith("CREATE ROLE"))
      ? "staging"
      : statements.some((sql) => sql.includes("'ALTER ROLE %I LOGIN PASSWORD %L'"))
        ? "activation"
        : statements.some((sql) =>
              /^UPDATE platform\.hotel_setup_\w+_scopes\s+SET credential_role_oid/.test(sql),
            )
          ? "readiness"
          : undefined;
  rds.setHook(async (client, sql, params, run) => {
    if (sql === "BEGIN") transactions.set(client, []);
    const statements = transactions.get(client);
    const targeted = statements?.some((entry) => entry.includes(target()));
    statements?.push(`${sql} ${JSON.stringify(params ?? [])}`);
    if (sql !== "COMMIT" || !statements || !targeted) return run();
    const committed = kind(statements);
    if (fault === "stagingRollback" && once(committed === "staging"))
      throw new Error("synthetic connection loss before COMMIT");
    const result = await run();
    if (
      once(
        (fault === "stagingCommitLost" && committed === "staging") ||
          (fault === "activationCommitLost" && committed === "activation") ||
          (fault === "readinessCommitLost" && committed === "readiness"),
      )
    )
      throw new Error("synthetic lost COMMIT acknowledgement");
    return result;
  });
  const prove = (proof: typeof flow.proveOrganization | typeof flow.proveProperty) => {
    const original = proof.getMockImplementation()!;
    proof.mockImplementation((async (client: pg.Client, scope: { organizationId: string }) => {
      if (
        fault === "rollbackProof" &&
        once(
          scope.organizationId === organizationId &&
            (proof === flow.proveOrganization ||
              (scope as { operation?: string }).operation === "launch_settings"),
        )
      )
        throw new Error("synthetic rollback proof failure");
      return (original as (...values: unknown[]) => Promise<void>)(client, scope);
    }) as never);
  };
  prove(flow.proveOrganization);
  prove(flow.proveProperty);
  const send = flow.aws.getMockImplementation()!;
  flow.aws.mockImplementation((async (command: unknown) => {
    const name = (command as { input?: { Name?: string; SecretId?: string } }).input;
    const targeted = `${name?.Name ?? name?.SecretId ?? ""}`.includes(target());
    if (command instanceof CreateSecretCommand && targeted) {
      if (fault === "publication" && once(true)) throw new Error("synthetic publication failure");
      const result = await (send as (value: unknown) => Promise<unknown>)(command);
      if (fault === "publicationLost" && once(true)) throw new Error("synthetic lost response");
      if (fault === "revokedBeforeReady" && once(true))
        await rds.su.query(
          "UPDATE identity.organization_memberships SET status='inactive' WHERE organization_id=$1 AND user_id=$2",
          [organizationId, actorUserId],
        );
      return result;
    }
    const result = await (send as (value: unknown) => Promise<unknown>)(command);
    if (command instanceof GetSecretValueCommand && fault === "readback" && once(targeted))
      return { ...(result as object), SecretString: "{}" };
    return result;
  }) as never);
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
  rds.setHook(undefined);
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

    // Each fault hits only hotel A's organization or its launch_settings purpose; unrelated hotel B
    // is provisioned in the same bounded passes and keeps serving.
    it.each(
      faults.flatMap((fault) =>
        (["organization", "property"] as const).map((mode) => [mode, fault] as const),
      ),
    )("keeps a %s %s attempt unavailable without duplicates or cleanup", async (mode, fault) => {
      await withRestrictedOperator(async (rds, flow) => {
        const { organizationId, actorUserId, options, creation, records, pass } = flow;
        const unrelated = await flow.addOrganization();
        const replay = async (scope: "organization" | "property") => {
          const result = await pass(scope);
          return result.receipts.length ? result : pass(scope); // Wrap an exhausted cursor once.
        };
        const status = async (scope: "organization" | "property") =>
          (await replay(scope)).receipts
            .filter((receipt) => receipt.organizationId === organizationId)
            .map((receipt) => receipt.status);
        let propertyId = "";
        let unrelatedPropertyId = "";
        const target = () =>
          mode === "organization"
            ? hotelSetupOrganizationRolePrefix(organizationId)
            : propertyRolePrefix(propertyId, "launch_settings");
        if (mode === "property") {
          expect(await status("organization")).toEqual(["provisioned"]);
          propertyId = (
            await creation.createPropertyProfile(firstSave(organizationId, actorUserId, "rds-a"))
          ).propertyId;
          unrelatedPropertyId = (
            await creation.createPropertyProfile(
              firstSave(unrelated.organizationId, unrelated.actorUserId, "rds-b"),
            )
          ).propertyId;
        }
        const secretsBefore = records.size;
        installFault(rds, flow, fault, target, organizationId, actorUserId);
        const first = await status(mode);
        rds.setHook(undefined);
        const expected = outcomes[fault][mode];
        expect(first).toEqual(expected.first);
        expect(await status(mode)).toEqual(expected.replay);
        expect(await status(mode)).toEqual(expected.settled);
        // One durable identity at most; never a second attempt or destructive recovery.
        const roles = await rds.su.query<{ rolname: string; rolcanlogin: boolean }>(
          "SELECT rolname,rolcanlogin FROM pg_roles WHERE starts_with(rolname,$1)",
          [target()],
        );
        expect(roles.rows).toHaveLength(1);
        expect(roles.rows[0]?.rolcanlogin).toBe(fault !== "stagingCommitLost");
        expect(
          rds.operations.statements.filter((sql) =>
            /DROP ROLE|NOLOGIN PASSWORD NULL|SET active=FALSE|pg_terminate_backend|DELETE FROM platform/i.test(
              sql,
            ),
          ),
        ).toEqual([]);
        // Plus hotel B's organization or three property-purpose secrets.
        expect(records.size - secretsBefore).toBe(
          expected.secrets + (mode === "organization" ? 1 : 3),
        );
        // Admission follows only the committed readiness row.
        const admitted =
          mode === "organization"
            ? createHotelSetupCreationCredentialResolver({
                ...options,
                secretPrefix: "hotel-setup-command/prod/organization/",
              })(organizationId)
            : createHotelSetupCredentialResolver(options, "launch_settings")(
                propertyId,
                organizationId,
              );
        if (expected.ready) await expect(admitted).resolves.toMatch(/^postgres/);
        else await expect(admitted).rejects.toThrow();
        // Unrelated hotel B is unaffected.
        if (mode === "organization")
          await expect(
            createHotelSetupCreationCredentialResolver({
              ...options,
              secretPrefix: "hotel-setup-command/prod/organization/",
            })(unrelated.organizationId),
          ).resolves.toMatch(/^postgres/);
        else {
          const nativeUrl = await createHotelSetupCredentialResolver(options, "launch_settings")(
            unrelatedPropertyId,
            unrelated.organizationId,
          );
          expect(
            await createHotelSetupLaunchSettingsCommands(options).updateLaunchSettings(
              owner(unrelated.organizationId, unrelated.actorUserId),
              unrelatedPropertyId,
              settings,
            ),
          ).toEqual(settings);
          // B's exact credential cannot act for A's property; A's scope cannot borrow B's.
          await expect(
            createHotelSetupCredentialResolver(options, "launch_settings")(
              unrelatedPropertyId,
              organizationId,
            ),
          ).rejects.toThrow();
          const native = new pg.Client({ connectionString: nativeUrl });
          await native.connect();
          try {
            await expect(
              checkHotelSetupPropertyCredential(native, {
                propertyId,
                organizationId,
                operation: "launch_settings",
              }),
            ).rejects.toThrow();
          } finally {
            await native.end();
          }
        }
        // A later revoked Owner loses B's admitted command at the next native transaction.
        if (mode === "property") {
          await rds.su.query(
            "UPDATE identity.organization_memberships SET status='inactive' WHERE organization_id=$1",
            [unrelated.organizationId],
          );
          await expect(
            createHotelSetupLaunchSettingsCommands(options).updateLaunchSettings(
              owner(unrelated.organizationId, unrelated.actorUserId),
              unrelatedPropertyId,
              settings,
            ),
          ).rejects.toThrow();
        }
        expect(rds.operations.catalog).toBe(0);
      });
    });
  },
);
