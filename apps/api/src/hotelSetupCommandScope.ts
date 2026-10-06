import type { QueryResultRow } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HotelSetupOperation = "currency" | "currency_ready" | "feature_hub" | "launch_settings";
export type HotelSetupPropertyPurpose = HotelSetupOperation | "property_logo";

type ScopeQuery = {
  query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
};

type ScopeClient = ScopeQuery & { release(): void };
type ScopePool = { connect(): Promise<ScopeClient> };

export async function assertHotelSetupCommandScope(
  client: ScopeQuery,
  scope: {
    propertyId: string;
    organizationId: string;
    operation: HotelSetupOperation;
  },
): Promise<void> {
  if (!UUID.test(scope.propertyId) || !UUID.test(scope.organizationId))
    throw new Error("Hotel setup command scope preflight failed");

  const result = await client.query<{
    sessionUser: string;
    currentUser: string;
    allowed: boolean;
    organizationAllowed: boolean;
    safeRole: boolean;
  }>(
    `SELECT session_user::text AS "sessionUser", current_user::text AS "currentUser",
      platform.hotel_setup_property_operation_allowed($1::uuid, $3::text) AS allowed,
      platform.hotel_setup_property_allowed($1::uuid, $2::uuid) AS "organizationAllowed",
      ${nativeRolePosture("vayada_next_hotel_setup_property_scope")} AS "safeRole"`,
    [scope.propertyId, scope.organizationId, scope.operation],
  );
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (
    !row ||
    row.sessionUser !== row.currentUser ||
    !/^vayada_next_hotel_setup_property_[a-z0-9_]+$/.test(row.sessionUser) ||
    !row.allowed ||
    !row.organizationAllowed ||
    !row.safeRole
  )
    throw new Error("Hotel setup command scope preflight failed");
}

/** Begins the transaction for repositories that own their commit/rollback lifecycle.
 * Callers must use this same client through completion and release it in finally. */
export async function beginHotelSetupCommandScope(
  client: ScopeQuery,
  scope: Parameters<typeof assertHotelSetupCommandScope>[1],
): Promise<void> {
  await client.query("BEGIN");
  await assertHotelSetupCommandScope(client, scope);
}

/** The assignment and owner locks stay held through the command's commit.
 * The platform's exact ACL and secret preflight is a separate release gate. */
export async function withHotelSetupCommandScope<T>(
  pool: ScopePool,
  scope: Parameters<typeof assertHotelSetupCommandScope>[1],
  work: (client: ScopeClient) => Promise<T>,
  attest?: (client: ScopeClient) => Promise<void>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await attest?.(client);
    await assertHotelSetupCommandScope(client, scope);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Creation uses an organization assignment before a property UUID exists.
 * Exact grants and relation/function contracts must still pass before writes. */
export async function assertHotelSetupCreationScope(
  client: ScopeQuery,
  organizationId: string,
): Promise<void> {
  if (!UUID.test(organizationId)) throw new Error("Hotel setup creation scope preflight failed");
  const result = await client.query<{
    sessionUser: string;
    currentUser: string;
    organizationAllowed: boolean;
    safeRole: boolean;
  }>(
    `SELECT session_user::text AS "sessionUser", current_user::text AS "currentUser",
    platform.hotel_setup_creation_assigned_organization() = $1::uuid AS "organizationAllowed",
    (${nativeRolePosture("vayada_next_hotel_setup_scope")}
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
        JOIN pg_catalog.pg_roles role ON role.oid = dependency.refobjid
        WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          AND role.rolname = session_user AND dependency.deptype = 'o'
          AND (dependency.dbid = 0 OR dependency.dbid = (SELECT oid FROM pg_catalog.pg_database
            WHERE datname = pg_catalog.current_database())))
    ) AS "safeRole"`,
    [organizationId],
  );
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (
    !row ||
    row.sessionUser !== row.currentUser ||
    !/^vayada_next_hotel_setup_org_[a-z0-9_]+$/.test(row.sessionUser) ||
    row.organizationAllowed !== true ||
    row.safeRole !== true
  )
    throw new Error("Hotel setup creation scope preflight failed");
}

function nativeRolePosture(
  parent: "vayada_next_hotel_setup_scope" | "vayada_next_hotel_setup_property_scope",
): string {
  return `EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles role
        WHERE role.rolname = session_user
          AND role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreaterole
          AND NOT role.rolcreatedb AND NOT role.rolbypassrls
          AND NOT role.rolreplication AND NOT role.rolinherit
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class relation
            WHERE relation.relowner = role.oid AND relation.relpersistence <> 't')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc routine
            WHERE routine.proowner = role.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace schema
            WHERE schema.nspowner = role.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database db
            WHERE db.datdba = role.oid)
          AND (SELECT count(*) FROM pg_catalog.pg_auth_members member
               WHERE member.member = role.oid) = 1
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members member
            JOIN pg_catalog.pg_roles parent ON parent.oid = member.roleid
            WHERE member.member = role.oid
              AND parent.rolname = '${parent}'
              AND member.inherit_option AND NOT member.set_option
              AND NOT member.admin_option
          )
      )`;
}

/** Called after BEGIN on the media repository's client; authority locks live until commit. */
export async function assertHotelSetupLogoScope(
  client: ScopeQuery,
  scope: { propertyId: string; organizationId: string; actorUserId: string },
): Promise<void> {
  await assertHotelSetupLogoAuthority(client, scope, "hotel_setup_logo_row_allowed");
}

/** Protected credential proof only; this predicate never admits media writes. */
export async function assertHotelSetupLogoBootstrapScope(
  client: ScopeQuery,
  scope: { propertyId: string; organizationId: string; actorUserId: string },
): Promise<void> {
  await assertHotelSetupLogoAuthority(client, scope, "hotel_setup_logo_bootstrap_proof_allowed");
}

async function assertHotelSetupLogoAuthority(
  client: ScopeQuery,
  scope: { propertyId: string; organizationId: string; actorUserId: string },
  predicate: "hotel_setup_logo_row_allowed" | "hotel_setup_logo_bootstrap_proof_allowed",
): Promise<void> {
  if (![scope.propertyId, scope.organizationId, scope.actorUserId].every((id) => UUID.test(id)))
    throw new Error("Hotel setup logo scope preflight failed");
  const result = await client.query<{
    sessionUser: string;
    currentUser: string;
    allowed: boolean;
  }>(
    `SELECT session_user::text AS "sessionUser", current_user::text AS "currentUser",
      platform.${predicate}($1::uuid,$2::uuid,$3::uuid) AS allowed`,
    [scope.propertyId, scope.organizationId, scope.actorUserId],
  );
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (
    !row ||
    row.sessionUser !== row.currentUser ||
    !/^vayada_next_hotel_setup_logo_[a-z0-9_]+$/.test(row.sessionUser) ||
    row.allowed !== true
  )
    throw new Error("Hotel setup logo scope preflight failed");
}
