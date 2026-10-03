import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { resolveEffectivePropertyAccess } from "@vayada/backend-authorization";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import type { HotelSetupOperation } from "./hotelSetupCommandScope.js";
import { lockHotelSetupMembership } from "./hotelSetupMembership.js";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";
import { HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES } from "./hotelSetupLaunchSettingsPrivileges.js";
import { HOTEL_SETUP_FEATURE_HUB_PRIVILEGES } from "./hotelSetupFeatureHubPrivileges.js";
import {
  HOTEL_SETUP_CURRENCY_PRIVILEGES,
  HOTEL_SETUP_CURRENCY_READY_PRIVILEGES,
} from "./hotelSetupCurrencyPrivileges.js";

export type HotelSetupPropertyBootstrapScope = {
  propertyId: string;
  organizationId: string;
  actorUserId: string;
  operation: HotelSetupOperation;
};
const inventories = {
  launch_settings: HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES,
  currency: HOTEL_SETUP_CURRENCY_PRIVILEGES,
  currency_ready: HOTEL_SETUP_CURRENCY_READY_PRIVILEGES,
  feature_hub: HOTEL_SETUP_FEATURE_HUB_PRIVILEGES,
};

/** Separate manual provisioner only, with service/caller admission blocked.
 * No password, assignment, secret or business command is created by staging. */
export async function stageHotelSetupPropertyRole(input: {
  adminDatabaseUrl: string;
  databaseEndpoint: string;
  scope: HotelSetupPropertyBootstrapScope;
}) {
  let admin: pg.Client | undefined;
  let failed = false;
  let incompleteGrant = false;
  let commitAttempted = false;
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const { propertyId, organizationId, actorUserId, operation } = input.scope;
    const scope = { propertyId, organizationId, actorUserId, operation };
    if (
      !uuid.test(scope.propertyId) ||
      !uuid.test(scope.organizationId) ||
      !uuid.test(scope.actorUserId) ||
      !Object.hasOwn(inventories, scope.operation)
    )
      throw new Error();
    const url = parseHotelSetupDatabaseUrl(
      input.adminDatabaseUrl,
      input.databaseEndpoint,
      decodeURIComponent(new URL(input.adminDatabaseUrl).username),
    );
    admin = new pg.Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true },
      options: "-c search_path=pg_catalog",
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
    });
    admin.on("error", () => {
      failed = true;
    });
    admin.on("notice", (notice) => {
      if (notice.code === "01007") incompleteGrant = true;
    });
    await admin.connect();
    await admin.query("BEGIN");
    await lockHotelSetupPropertyBootstrapAuthority(admin, scope);
    // A stable prefix finds an earlier disabled attempt even before assignment exists.
    // It only rejects retries; the database assignment remains the scope authority.
    const prefix = `vayada_next_hotel_setup_property_${createHash("sha256")
      .update(`${scope.propertyId.toLowerCase()}:${scope.operation}`)
      .digest("hex")
      .slice(0, 16)}_`;
    const staged = await admin.query(
      "SELECT oid FROM pg_catalog.pg_roles WHERE pg_catalog.left(rolname::text,length($1))=$1",
      [prefix],
    );
    const existing = await admin.query(
      `SELECT database_login FROM platform.hotel_setup_property_scopes
       WHERE property_id=$1::uuid AND operation_class=$2 FOR UPDATE`,
      [scope.propertyId, scope.operation],
    );
    if (failed || staged.rows.length || existing.rows.length) throw new Error();
    const login = `${prefix}${randomBytes(6).toString("hex")}`;
    const role = admin.escapeIdentifier(login);
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT vayada_next_hotel_setup_property_scope TO ${role}
      WITH INHERIT TRUE, SET FALSE`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(decodeURIComponent(url.pathname.slice(1)))} TO ${role}`,
    );
    const inventory = inventories[scope.operation];
    const schemas = [...new Set(Object.keys(inventory).map((table) => table.split(".")[0]!))];
    await admin.query(`GRANT USAGE ON SCHEMA ${schemas.join(",")} TO ${role}`);
    for (const [table, privileges] of Object.entries(inventory))
      for (const [privilege, columns] of Object.entries(privileges))
        await admin.query(`GRANT ${privilege}(${columns.join(",")}) ON ${table} TO ${role}`);
    if (scope.operation === "launch_settings")
      await admin.query(`GRANT DELETE ON hotel_catalog.property_contact_channels TO ${role}`);
    const result = await admin.query<{ oid: number }>(
      "SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1",
      [login],
    );
    if (failed || incompleteGrant || result.rows.length !== 1) throw new Error();
    commitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
    return { login, roleOid: result.rows[0]!.oid, ...scope };
  } catch {
    await admin?.query("ROLLBACK").catch(() => undefined);
    // Lost commit may have left a disabled role. Never retry/adopt it blindly.
    throw new Error(
      commitAttempted
        ? "Hotel setup property staging requires recovery inspection"
        : "Hotel setup property staging failed",
    );
  } finally {
    await admin?.end().catch(() => undefined);
  }
}

/** Reused by later activation/publication; take current authority locks, not stale claims. */
export async function lockHotelSetupPropertyBootstrapAuthority(
  admin: pg.Client,
  scope: HotelSetupPropertyBootstrapScope,
) {
  const owner = await admin.query(
    `SELECT property.id FROM hotel_catalog.properties property
     JOIN identity.organizations organization ON organization.id=$2::uuid
       AND organization.kind='hotel_group' AND organization.status='active'
     JOIN identity.organization_resource_links catalog ON catalog.organization_id=organization.id
       AND catalog.product='hotel_catalog' AND catalog.resource_type='property'
       AND lower(catalog.resource_id)=$1::uuid::text AND catalog.relationship='owner' AND catalog.status='active'
     JOIN identity.organization_resource_links pms ON pms.organization_id=organization.id
       AND pms.product='pms' AND pms.resource_type='pms_property'
       AND lower(pms.resource_id)=$1::uuid::text AND pms.relationship='owner' AND pms.status='active'
     WHERE property.id=$1::uuid FOR UPDATE OF property FOR SHARE OF organization,catalog,pms`,
    [scope.propertyId, scope.organizationId],
  );
  if (owner.rows.length !== 1) throw new Error("Hotel setup property authority unavailable");
  if (scope.operation === "launch_settings") {
    const membership = await lockHotelSetupMembership(admin, scope);
    const access =
      membership &&
      (await resolveEffectivePropertyAccess(membership.context, {
        async findMembershipPropertyScope() {
          return membership.scope;
        },
      }));
    if (
      !membership?.permissions.includes("hotel_catalog.setup.manage") ||
      !access?.propertyIds.includes(scope.propertyId)
    )
      throw new Error("Hotel setup property actor unavailable");
  } else if (
    !(await lockHotelSetupCurrencyMembership(
      admin,
      {
        ...scope,
        audit: {
          actor: { kind: "user", userId: scope.actorUserId },
          requestId: "manual-property-bootstrap",
          correlationId: null,
          requestedAt: new Date().toISOString(),
        },
      },
      {
        permission:
          scope.operation === "feature_hub" ? "pms.finance.manage" : "pms.operations.manage",
        requireBaseAccess: scope.operation !== "feature_hub",
      },
    ))
  )
    throw new Error("Hotel setup property actor unavailable");
}
