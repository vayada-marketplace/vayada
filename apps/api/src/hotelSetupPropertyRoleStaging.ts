import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import {
  hasActiveEntitlement,
  resolveEffectivePropertyAccess,
} from "@vayada/backend-authorization";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import type { HotelSetupOperation } from "./hotelSetupCommandScope.js";
import { lockHotelSetupMembership } from "./hotelSetupMembership.js";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";
import { HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES } from "./hotelSetupLaunchSettingsPrivileges.js";
import {
  HOTEL_SETUP_FEATURE_HUB_PRIVILEGES,
  HOTEL_SETUP_PROPERTY_RLS_HELPERS,
} from "./hotelSetupFeatureHubPrivileges.js";
import {
  HOTEL_SETUP_CURRENCY_PRIVILEGES,
  HOTEL_SETUP_CURRENCY_READY_PRIVILEGES,
} from "./hotelSetupCurrencyPrivileges.js";

export type HotelSetupPropertyBootstrapScope = {
  propertyId: string;
  organizationId: string;
  actorUserId: string;
  operation: HotelSetupOperation;
  /** Trusted reconciler only: adds eligibility checks; never bypasses manual release gates. */
  automatic?: true;
};
const inventories = {
  launch_settings: HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES,
  currency: HOTEL_SETUP_CURRENCY_PRIVILEGES,
  currency_ready: HOTEL_SETUP_CURRENCY_READY_PRIVILEGES,
  feature_hub: HOTEL_SETUP_FEATURE_HUB_PRIVILEGES,
};

/** Isolated provisioner only; manual callers retain their blocked service gate.
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
    const { propertyId, organizationId, actorUserId, operation, automatic } = input.scope;
    const scope = {
      propertyId,
      organizationId,
      actorUserId,
      operation,
      ...(automatic ? { automatic } : {}),
    };
    if (
      !uuid.test(scope.propertyId) ||
      !uuid.test(scope.organizationId) ||
      !uuid.test(scope.actorUserId) ||
      !Object.hasOwn(inventories, scope.operation) ||
      (automatic !== undefined && automatic !== true) ||
      (automatic && operation === "currency")
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
    const helpers = HOTEL_SETUP_PROPERTY_RLS_HELPERS[scope.operation];
    if (helpers.length) {
      const helper = await admin.query<{ safe: boolean }>(
        "SELECT NOT prosecdef AS safe FROM pg_catalog.pg_proc WHERE oid=ANY($1::regprocedure[])",
        [helpers],
      );
      if (helper.rows.length !== helpers.length || helper.rows.some(({ safe }) => safe !== true))
        throw new Error();
      for (const signature of helpers)
        await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
    }
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
  if (scope.automatic) {
    const organization = await admin.query(
      `SELECT id FROM identity.organizations WHERE id=$1::uuid
       AND kind='hotel_group' AND status='active' FOR UPDATE`,
      [scope.organizationId],
    );
    if (organization.rows.length !== 1)
      throw new Error("Hotel setup property authority unavailable");
  }
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
  if (scope.automatic) await lockHotelSetupAutomaticPropertyEligibility(admin, scope);
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

/** Existing manual authority stays intact; online setup additionally requires the
 * selected commercial bundle and both current products, without enabling either. */
async function lockHotelSetupAutomaticPropertyEligibility(
  admin: pg.Client,
  scope: HotelSetupPropertyBootstrapScope,
) {
  if (scope.operation === "currency") throw new Error("Unused automatic property purpose");
  const intent = await admin.query<{ selected_tracks: string[] }>(
    `SELECT selected_tracks FROM hotel_catalog.organization_setup_track_intents
     WHERE organization_id=$1::uuid FOR SHARE`,
    [scope.organizationId],
  );
  const bookingOwner = await admin.query(
    `SELECT resource_id FROM identity.organization_resource_links
     WHERE organization_id=$1::uuid AND product='booking' AND resource_type='booking_hotel'
       AND lower(resource_id)=$2::uuid::text AND relationship='owner' AND status='active' FOR SHARE`,
    [scope.organizationId, scope.propertyId],
  );
  const membership = await lockHotelSetupMembership(admin, scope);
  if (
    intent.rows.length !== 1 ||
    !intent.rows[0]?.selected_tracks.includes("hotel_operations") ||
    bookingOwner.rows.length !== 1 ||
    !membership?.scope.productAccess?.pms ||
    !membership.scope.productAccess.booking
  )
    throw new Error("Hotel setup automatic products unavailable");
  const entitlements = await admin.query<{
    product: string;
    key: string;
    status: "active" | "suspended" | "expired";
    resourceProduct: string | null;
    resourceType: string | null;
    resourceId: string | null;
    startsAt: Date | null;
    expiresAt: Date | null;
  }>(
    `SELECT product,entitlement_key AS key,status,resource_product AS "resourceProduct",
       resource_type AS "resourceType",resource_id AS "resourceId",
       starts_at AS "startsAt",expires_at AS "expiresAt"
     FROM identity.product_entitlements WHERE organization_id=$1::uuid FOR SHARE`,
    [scope.organizationId],
  );
  const billing = await admin.query<{
    product: string;
    key: string;
    propertyId: string | null;
    status: string;
    startsAt: Date | null;
    expiresAt: Date | null;
  }>(
    `SELECT product,entitlement_key AS key,property_id::text AS "propertyId",
       billing_status AS status,starts_at AS "startsAt",expires_at AS "expiresAt"
     FROM finance.billing_entitlements WHERE organization_id=$1::uuid FOR SHARE`,
    [scope.organizationId],
  );
  const clock = await admin.query<{ at: Date }>("SELECT pg_catalog.clock_timestamp() AS at");
  const at = clock.rows[0]?.at;
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error();
  for (const product of ["pms", "booking"] as const) {
    const resourceType = product === "pms" ? "pms_property" : "booking_hotel";
    const context = {
      entitlements: entitlements.rows
        .filter(
          (row) =>
            ["pms", "booking"].includes(row.product) &&
            (row.resourceProduct === null ||
              (row.resourceProduct === row.product &&
                row.resourceType === (row.product === "pms" ? "pms_property" : "booking_hotel") &&
                row.resourceId?.toLowerCase() === scope.propertyId.toLowerCase())) &&
            (row.startsAt === null || row.startsAt <= at),
        )
        .map((row) => ({
          product: row.product as "pms" | "booking",
          key: row.key,
          status: row.expiresAt !== null && row.expiresAt <= at ? ("expired" as const) : row.status,
          ...(row.resourceProduct === null
            ? {}
            : {
                resource: {
                  product: row.product as "pms" | "booking",
                  resourceType:
                    row.product === "pms" ? ("pms_property" as const) : ("booking_hotel" as const),
                  resourceId: scope.propertyId,
                },
              }),
        })),
    };
    // Lock the complete organization inventories before filtering. An excluded
    // existing row must not be retargeted to a global denial during this proof.
    const bills = billing.rows.filter(
      (row) =>
        row.product === product &&
        (row.propertyId === null || row.propertyId === scope.propertyId.toLowerCase()) &&
        (product === "pms"
          ? ["property-management", "pms-core", "account_access"]
          : ["booking-engine", "account_access"]
        ).includes(row.key),
    );
    const current = bills.filter(
      (row) =>
        (row.startsAt === null || row.startsAt <= at) &&
        (row.expiresAt === null || row.expiresAt > at),
    );
    if (
      !hasActiveEntitlement(context, {
        product,
        key: product === "pms" ? "property-management" : "booking-engine",
        resource: { product, resourceType, resourceId: scope.propertyId },
      }) ||
      current.some((row) => ["past_due", "suspended"].includes(row.status)) ||
      (bills.length && !current.some((row) => ["trialing", "active"].includes(row.status)))
    )
      throw new Error("Hotel setup automatic products unavailable");
  }
}
