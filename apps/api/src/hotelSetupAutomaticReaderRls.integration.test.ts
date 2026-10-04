import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutomaticOwnerFlowFixture } from "./hotelSetupAutomaticOwnerFlow.fixture.js";
import { createHotelSetupCreationCommands } from "./hotelSetupCreationCommands.js";
import { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import {
  createHotelSetupCreationCredentialResolver,
  createHotelSetupCredentialResolver,
} from "./hotelSetupCommandCredentials.js";
import {
  assertHotelSetupReaderPrivileges,
  HOTEL_SETUP_CREATION_READER_READ_COLUMNS,
  HOTEL_SETUP_READER_READ_COLUMNS,
  HOTEL_SETUP_READER_AUDIT_COLUMNS,
  HOTEL_SETUP_READER_RLS_HELPERS,
} from "./hotelSetupReaderPrivileges.js";

const databaseUrl = process.env.HOTEL_SETUP_AUTOMATIC_OWNER_FLOW_TEST_DATABASE_URL;
const rollbackRoot = process.env.HOTEL_SETUP_AUTOMATIC_ROLLBACK_PREFLIGHT_ROOT;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.runIf(databaseUrl && rollbackRoot)(
  "automatic setup with hardened worker helper ACLs",
  () => {
    it("uses real serving readers and preserves native scope proof under PUBLIC EXECUTE denial", async () => {
      const fixture = await createAutomaticOwnerFlowFixture(databaseUrl!, rollbackRoot!);
      const { admin, organizationId, actorUserId } = fixture;
      const logins = ["vayada_next_hotel_setup_creation_reader", "vayada_next_hotel_setup_reader"];
      const owned = new Map<string, number>();
      const connections: pg.Client[] = [];
      const helperBaseline: { name: string; public: boolean }[] = [];
      const denials: { code: "42501"; role: string; function: string }[] = [];
      const originalQuery = pg.Client.prototype.query;
      const query = vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        try {
          return await (
            originalQuery as unknown as (...values: unknown[]) => Promise<unknown>
          ).apply(this, args);
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          const routine = failure.message?.match(/^permission denied for function ([a-z_]+)$/)?.[1];
          if (failure.code === "42501" && routine)
            denials.push({
              code: "42501",
              role: (this as pg.Client & { user: string }).user,
              function: routine,
            });
          throw error;
        }
      } as never);
      const nativeDenials = () =>
        denials.filter(({ role }) => /^vayada_next_hotel_setup_(org|property)_/.test(role));
      try {
        expect(HOTEL_SETUP_READER_RLS_HELPERS).toEqual([
          "platform.channex_management_worker_source(text,text,uuid)",
          "platform.channex_management_worker_scope(text,text,uuid)",
        ]);
        helperBaseline.push(
          ...(
            await admin.query<{ name: string; public: boolean }>(
              `SELECT p.oid::regprocedure::text AS name, EXISTS(SELECT 1 FROM
           aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
           WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public
           FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])`,
              [HOTEL_SETUP_READER_RLS_HELPERS],
            )
          ).rows,
        );
        expect(
          (await admin.query("SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])", [logins]))
            .rows,
        ).toEqual([]);
        expect(helperBaseline).toHaveLength(2);
        for (const helper of HOTEL_SETUP_READER_RLS_HELPERS)
          await admin.query(`REVOKE EXECUTE ON FUNCTION ${helper} FROM PUBLIC`);
        for (const [index, login] of logins.entries()) {
          const password = randomBytes(36).toString("base64url");
          await admin.query(
            `CREATE ROLE ${admin.escapeIdentifier(login)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(password)}`,
          );
          owned.set(
            login,
            (await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [login])).rows[0].oid,
          );
          await admin.query(
            `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(new URL(databaseUrl!).pathname.slice(1))} TO ${admin.escapeIdentifier(login)}`,
          );
          await admin.query(
            `GRANT USAGE ON SCHEMA identity,platform TO ${admin.escapeIdentifier(login)}`,
          );
          for (const [relation, fields] of Object.entries(
            index === 0
              ? HOTEL_SETUP_CREATION_READER_READ_COLUMNS
              : HOTEL_SETUP_READER_READ_COLUMNS,
          ))
            await admin.query(
              `GRANT SELECT(${fields.join(",")}) ON ${relation} TO ${admin.escapeIdentifier(login)}`,
            );
          await admin.query(
            `GRANT INSERT(${HOTEL_SETUP_READER_AUDIT_COLUMNS.join(",")}) ON platform.product_audit_events TO ${admin.escapeIdentifier(login)}`,
          );
          const url = new URL(databaseUrl!);
          url.username = login;
          url.password = password;
          const reader = new pg.Client({ connectionString: url.href });
          connections.push(reader);
          await reader.connect();
          await expect(
            assertHotelSetupReaderPrivileges(
              reader,
              index === 0 ? "property_creation" : "property_commands",
            ),
          ).rejects.toThrow("RLS helper privileges unavailable");
          await expect(
            reader.query("SELECT id FROM identity.organizations WHERE id=$1", [organizationId]),
          ).rejects.toMatchObject({ code: "42501" });
          expect(denials).toContainEqual({
            code: "42501",
            role: login,
            function: "channex_management_worker_source",
          });
          for (const helper of HOTEL_SETUP_READER_RLS_HELPERS)
            await admin.query(
              `GRANT EXECUTE ON FUNCTION ${helper} TO ${admin.escapeIdentifier(login)}`,
            );
          await expect(
            assertHotelSetupReaderPrivileges(
              reader,
              index === 0 ? "property_creation" : "property_commands",
            ),
          ).resolves.toBeUndefined();
          expect(
            (
              await reader.query("SELECT id FROM identity.organizations WHERE id=$1", [
                organizationId,
              ])
            ).rows,
          ).toEqual([{ id: organizationId }]);
          await expect(
            reader.query("UPDATE identity.organizations SET status='inactive' WHERE id=$1", [
              organizationId,
            ]),
          ).rejects.toMatchObject({ code: "42501" });
        }
        const organization = await fixture.pass("organization");
        expect(
          organization.receipts.map((r) => r.status),
          JSON.stringify(nativeDenials()),
        ).toEqual(["provisioned"]);
        expect(fixture.proveOrganization).toHaveBeenCalledOnce();
        const options = {
          ...fixture.options,
          assignments: connections[0]!,
          secretPrefix: "hotel-setup-command/prod/organization/",
        };
        const resolve = createHotelSetupCreationCredentialResolver(options);
        const nativeUrl = await resolve(organizationId);
        expect(new URL(nativeUrl).username).toMatch(/^vayada_next_hotel_setup_org_/);
        const native = new pg.Client({ connectionString: nativeUrl });
        connections.push(native);
        await native.connect();
        await admin.query(`REVOKE EXECUTE ON FUNCTION ${HOTEL_SETUP_READER_RLS_HELPERS[0]}
          FROM ${admin.escapeIdentifier(new URL(nativeUrl).username)}`);
        await expect(
          checkHotelSetupCreationCredential(native, { organizationId, actorUserId }),
        ).rejects.toThrow("privilege posture mismatch");
        await admin.query(`GRANT EXECUTE ON FUNCTION ${HOTEL_SETUP_READER_RLS_HELPERS[0]}
          TO ${admin.escapeIdentifier(new URL(nativeUrl).username)}`);
        await expect(
          checkHotelSetupCreationCredential(native, { organizationId: randomUUID(), actorUserId }),
        ).rejects.toThrow();
        await admin.query(
          `REVOKE EXECUTE ON FUNCTION ${HOTEL_SETUP_READER_RLS_HELPERS[0]} FROM ${logins[0]}`,
        );
        const calls = fixture.aws.mock.calls.length;
        await expect(resolve(organizationId)).rejects.toMatchObject({ code: "42501" });
        expect(fixture.aws.mock.calls.length).toBe(calls);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION ${HOTEL_SETUP_READER_RLS_HELPERS[0]} TO ${logins[0]}`,
        );
        const input = {
          organizationId,
          idempotencyKey: "hardened-first-save",
          correlationId: "hardened-first-save",
          profile: {
            displayName: "Synthetic hardened hotel",
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
              mapDisplayMode: "hidden" as const,
            },
            contacts: [
              {
                channelType: "email" as const,
                value: "owner@fixture.invalid",
                purpose: "guest" as const,
                isPublic: false,
              },
            ],
            initialLaunchSettings: {
              defaultCurrency: "LKR",
              supportedCurrencies: ["LKR"],
              defaultLanguage: "en",
              supportedLanguages: ["en"],
              instagram: "",
              facebook: "",
              tiktok: "",
              youtube: "",
            },
          },
          audit: {
            actorUserId,
            requestId: "hardened-first-save",
            receivedAt: new Date().toISOString(),
          },
        };
        const creation = createHotelSetupCreationCommands(options);
        let first: Awaited<ReturnType<typeof creation.createPropertyProfile>>;
        try {
          first = await creation.createPropertyProfile(input);
        } catch {
          throw new Error(`Native first Save denied: ${JSON.stringify(nativeDenials())}`);
        }
        expect((await creation.createPropertyProfile(input)).propertyId).toBe(first.propertyId);
        const property = await fixture.pass("property");
        expect(
          property.receipts.map((r) => r.status),
          JSON.stringify(nativeDenials()),
        ).toEqual(["provisioned", "provisioned", "provisioned"]);
        expect(fixture.proveProperty).toHaveBeenCalledTimes(3);
        const propertyOptions = { ...fixture.options, assignments: connections[1]! };
        for (const purpose of ["launch_settings", "currency_ready", "feature_hub"] as const) {
          const nativeUrl = await createHotelSetupCredentialResolver(propertyOptions, purpose)(
            first.propertyId,
            organizationId,
          );
          expect(new URL(nativeUrl).username).toMatch(/^vayada_next_hotel_setup_property_/);
          const native = new pg.Client({ connectionString: nativeUrl });
          connections.push(native);
          await native.connect();
          await expect(
            checkHotelSetupPropertyCredential(native, {
              propertyId: randomUUID(),
              organizationId,
              operation: purpose,
            }),
          ).rejects.toThrow();
        }
        expect(
          (
            await admin.query(
              `SELECT
        (SELECT count(*) FROM pms.property_pricing_settings WHERE property_id=$1)::int AS pricing,
        (SELECT count(*) FROM finance.expense_categories WHERE property_id=$1)::int AS categories,
        (SELECT status FROM identity.product_entitlements WHERE organization_id=$2 AND resource_id=$1::uuid::text AND entitlement_key='module:financials') AS financials`,
              [first.propertyId, organizationId],
            )
          ).rows,
        ).toEqual([{ pricing: 0, categories: 0, financials: "suspended" }]);
        expect(nativeDenials()).toEqual([]);
      } finally {
        query.mockRestore();
        for (const connection of connections) await connection.end();
        try {
          for (const [login, oid] of owned) {
            expect(
              (await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [login])).rows,
            ).toEqual([{ oid }]);
            await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(login)}`);
            await admin.query(`DROP ROLE ${admin.escapeIdentifier(login)}`);
          }
        } finally {
          try {
            for (const helper of helperBaseline)
              if (helper.public)
                await admin.query(`GRANT EXECUTE ON FUNCTION ${helper.name} TO PUBLIC`);
          } finally {
            await fixture.close();
          }
        }
      }
    }, 60_000);
  },
);
