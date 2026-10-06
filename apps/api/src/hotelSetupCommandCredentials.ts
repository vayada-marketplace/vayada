import type pg from "pg";
import type { HotelSetupNativeSecretReader } from "./hotelSetupNativeSecretReader.js";

export type HotelSetupCredentialOptions = {
  assignments: Pick<pg.Pool, "query">;
  readNativeSecret: HotelSetupNativeSecretReader;
  databaseEndpoint: string;
  secretPrefix: string;
};

export function parseHotelSetupCredentialConfiguration(
  options: Pick<HotelSetupCredentialOptions, "databaseEndpoint" | "secretPrefix">,
): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(options.databaseEndpoint);
  } catch {
    throw new Error("Invalid hotel setup credential configuration");
  }
  if (
    !["postgres:", "postgresql:"].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.pathname.length < 2 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^[A-Za-z0-9/_+=.@-]{1,256}\/$/.test(options.secretPrefix) ||
    options.secretPrefix.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error("Invalid hotel setup credential configuration");
  return endpoint;
}

/** Private service only. Purpose comes from the adapter, never the HTTP caller. */
export function createHotelSetupCredentialResolver(
  options: HotelSetupCredentialOptions,
  operation: "currency_ready" | "feature_hub" | "launch_settings",
) {
  if (!["currency_ready", "feature_hub", "launch_settings"].includes(operation))
    throw new Error("Invalid hotel setup credential purpose");
  const endpoint = parseHotelSetupCredentialConfiguration(options);
  const secretPrefix = options.secretPrefix;

  return async (propertyId: string, organizationId: string): Promise<string> => {
    const result = await options.assignments.query<{
      databaseLogin: string;
      propertyId: string;
      organizationId: string;
      operation: string;
      credentialRoleOid: number;
      actualRoleOid: number;
      credentialSecretVersion: string;
      credentialReadyAt: Date;
    }>(
      `SELECT scope.database_login::text AS "databaseLogin",
            scope.property_id::text AS "propertyId",
            scope.organization_id::text AS "organizationId",
            scope.operation_class AS operation,
            scope.credential_role_oid AS "credentialRoleOid", role.oid AS "actualRoleOid",
            scope.credential_secret_version AS "credentialSecretVersion",
            scope.credential_ready_at AS "credentialReadyAt"
           FROM platform.hotel_setup_property_scopes scope
           JOIN pg_catalog.pg_roles role ON role.rolname=scope.database_login
           JOIN identity.organizations organization ON organization.id=scope.organization_id
           WHERE scope.active AND scope.property_id=$1::uuid
             AND scope.organization_id=$2::uuid AND scope.operation_class=$3
             AND scope.credential_role_oid=role.oid AND role.rolcanlogin
             AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL
             AND organization.kind='hotel_group' AND organization.status='active'
             AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
               WHERE link.organization_id=scope.organization_id
                 AND link.product='hotel_catalog' AND link.resource_type='property'
                 AND lower(link.resource_id)=$1::uuid::text
                 AND link.relationship='owner' AND link.status='active')
             AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
               WHERE link.organization_id=scope.organization_id
                 AND link.product='pms' AND link.resource_type='pms_property'
                 AND lower(link.resource_id)=$1::uuid::text
                 AND link.relationship='owner' AND link.status='active')`,
      [propertyId, organizationId, operation],
    );
    const scope = result.rows.length === 1 ? result.rows[0] : undefined;
    if (
      !scope ||
      scope.propertyId !== propertyId ||
      scope.organizationId !== organizationId ||
      scope.operation !== operation ||
      !isReadyCredential(scope) ||
      !/^vayada_next_hotel_setup_property_[a-z0-9_]+$/.test(scope.databaseLogin) ||
      Buffer.byteLength(scope.databaseLogin) > 63
    )
      throw new Error("Missing hotel setup assignment");

    return readNativeSetupCredential(options.readNativeSecret, endpoint, secretPrefix, scope);
  };
}

/** Private logo only: purpose and actor are server-owned, never chosen by an HTTP override. */
export function createHotelSetupLogoCredentialResolver(options: HotelSetupCredentialOptions) {
  return createHotelSetupActorCredentialResolver(options, "property_logo");
}

/** Actor-bound purposes; the adapter fixes the purpose, never the HTTP caller. */
export function createHotelSetupActorCredentialResolver(
  options: HotelSetupCredentialOptions,
  purpose: "property_logo" | "property_profile",
) {
  const kind = { property_logo: "logo", property_profile: "profile" }[purpose];
  if (!kind) throw new Error("Invalid hotel setup credential purpose");
  const endpoint = parseHotelSetupCredentialConfiguration(options);
  return async (
    propertyId: string,
    organizationId: string,
    actorUserId: string,
  ): Promise<string> => {
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
    if (![propertyId, organizationId, actorUserId].every((id) => uuid.test(id)))
      throw new Error(`Missing hotel setup ${kind} assignment`);
    const result = await options.assignments.query<
      ReadyCredential & {
        propertyId: string;
        organizationId: string;
        actorUserId: string;
      }
    >(
      `SELECT scope.database_login::text AS "databaseLogin", scope.property_id::text AS "propertyId",
      scope.organization_id::text AS "organizationId", scope.actor_user_id::text AS "actorUserId",
      scope.credential_role_oid AS "credentialRoleOid", role.oid AS "actualRoleOid",
      scope.credential_secret_version AS "credentialSecretVersion", scope.credential_ready_at AS "credentialReadyAt"
      FROM platform.hotel_setup_property_scopes scope
      JOIN pg_catalog.pg_roles role ON role.rolname=scope.database_login
      JOIN identity.organizations organization ON organization.id=scope.organization_id
      WHERE scope.active AND scope.operation_class='${purpose}' AND scope.property_id=$1::uuid
        AND scope.organization_id=$2::uuid AND scope.actor_user_id=$3::uuid
        AND scope.credential_role_oid=role.oid AND role.rolcanlogin AND role.rolvaliduntil IS NULL
        AND NOT (role.rolinherit OR role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting setting WHERE setting.setrole=role.oid)
        AND EXISTS (SELECT 1 FROM identity.users actor JOIN identity.organization_memberships member
          ON member.user_id=actor.id AND member.organization_id=scope.organization_id
          WHERE actor.id=scope.actor_user_id AND actor.status='active' AND member.status='active'
            AND member.role_key='hotel_owner'
            AND (member.permission_overrides IS NULL OR member.permission_overrides='{"grant":[],"deny":[]}'::jsonb)
            AND (member.role_definition_id IS NULL OR EXISTS (SELECT 1 FROM identity.organization_roles definition
              WHERE definition.id=member.role_definition_id AND definition.organization_id=scope.organization_id
                AND definition.security_class='account_admin' AND definition.base_role_key='hotel_owner'
                AND definition.preset_key='account_admin' AND definition.default_permissions='[]'::jsonb))
            AND (member.property_access_mode='all' OR (member.property_access_mode='assigned'
              AND EXISTS (SELECT 1 FROM identity.membership_property_assignments assignment
                WHERE assignment.membership_id=member.id AND assignment.property_id=scope.property_id))))
        AND EXISTS (SELECT 1 FROM identity.role_permission_grants permission
          WHERE permission.organization_kind='hotel_group' AND permission.role_key='hotel_owner'
            AND permission.permission_key='hotel_catalog.setup.manage')
        AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL
        AND organization.kind='hotel_group' AND organization.status='active'
        AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
          WHERE link.organization_id=scope.organization_id AND link.product='hotel_catalog'
            AND link.resource_type='property' AND lower(link.resource_id)=$1::uuid::text
            AND link.relationship='owner' AND link.status='active')`,
      [propertyId, organizationId, actorUserId],
    );
    const scope = result.rows.length === 1 ? result.rows[0] : undefined;
    if (
      !scope ||
      scope.propertyId !== propertyId ||
      scope.organizationId !== organizationId ||
      scope.actorUserId !== actorUserId ||
      !isReadyCredential(scope) ||
      !new RegExp(`^vayada_next_hotel_setup_${kind}_[a-z0-9_]+$`).test(scope.databaseLogin) ||
      Buffer.byteLength(scope.databaseLogin) > 63
    )
      throw new Error(`Missing hotel setup ${kind} assignment`);
    return readNativeSetupCredential(
      options.readNativeSecret,
      endpoint,
      options.secretPrefix,
      scope,
    );
  };
}

/** Private creation only; the database assignment selects an organization-bound native login. */
export function createHotelSetupCreationCredentialResolver(options: HotelSetupCredentialOptions) {
  const endpoint = parseHotelSetupCredentialConfiguration(options);
  const prefix = options.secretPrefix;
  return async (organizationId: string): Promise<string> => {
    const result = await options.assignments.query<{
      databaseLogin: string;
      organizationId: string;
      credentialRoleOid: number;
      actualRoleOid: number;
      credentialSecretVersion: string;
      credentialReadyAt: Date;
    }>(
      `SELECT scope.database_login::text AS "databaseLogin",
        scope.organization_id::text AS "organizationId",
        scope.credential_role_oid AS "credentialRoleOid", role.oid AS "actualRoleOid",
        scope.credential_secret_version AS "credentialSecretVersion",
        scope.credential_ready_at AS "credentialReadyAt"
       FROM platform.hotel_setup_creation_scopes scope
       JOIN pg_catalog.pg_roles role ON role.rolname=scope.database_login
       JOIN identity.organizations organization ON organization.id=scope.organization_id
       WHERE scope.organization_id=$1::uuid
         AND scope.credential_role_oid=role.oid AND role.rolcanlogin
         AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL
         AND organization.kind='hotel_group' AND organization.status='active'`,
      [organizationId],
    );
    const scope = result.rows.length === 1 ? result.rows[0] : undefined;
    if (
      !scope ||
      scope.organizationId !== organizationId ||
      !isReadyCredential(scope) ||
      !/^vayada_next_hotel_setup_org_[a-z0-9_]+$/.test(scope.databaseLogin) ||
      Buffer.byteLength(scope.databaseLogin) > 63
    )
      throw new Error("Missing hotel setup creation assignment");
    return readNativeSetupCredential(options.readNativeSecret, endpoint, prefix, scope);
  };
}

type ReadyCredential = {
  databaseLogin: string;
  credentialRoleOid: number;
  actualRoleOid: number;
  credentialSecretVersion: string;
  credentialReadyAt: Date;
};
function isReadyCredential(scope: ReadyCredential): boolean {
  return (
    Number.isInteger(scope.credentialRoleOid) &&
    scope.credentialRoleOid > 0 &&
    scope.credentialRoleOid === scope.actualRoleOid &&
    /^[A-Za-z0-9-]{32,64}$/.test(scope.credentialSecretVersion) &&
    scope.credentialReadyAt instanceof Date &&
    Number.isFinite(scope.credentialReadyAt.getTime())
  );
}

async function readNativeSetupCredential(
  readNativeSecret: HotelSetupCredentialOptions["readNativeSecret"],
  endpoint: URL,
  secretPrefix: string,
  scope: ReadyCredential,
): Promise<string> {
  const databaseLogin = scope.databaseLogin;
  const secret = await readNativeSecret(
    secretPrefix + databaseLogin,
    scope.credentialSecretVersion,
  );
  if (
    typeof secret !== "object" ||
    secret === null ||
    Array.isArray(secret) ||
    Object.keys(secret).length !== 2 ||
    !("username" in secret) ||
    !("password" in secret) ||
    secret.username !== databaseLogin ||
    typeof secret.password !== "string" ||
    Buffer.byteLength(secret.password) < 32
  )
    throw new Error("Invalid hotel setup credential");

  const connection = new URL(endpoint);
  connection.username = databaseLogin;
  connection.password = encodeURIComponent(secret.password);
  connection.searchParams.set("sslmode", "verify-full");
  return connection.toString();
}
