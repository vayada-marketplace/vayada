import { AuthorizationError } from "@vayada/backend-authorization";
import type { QueryResultRow } from "pg";

type ScopeQuery = {
  query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
};
type ScopeClient = ScopeQuery & { release(): void };
type ScopePool = { connect(): Promise<ScopeClient> };

export type HotelSetupPropertyScope = { propertyId: string; organizationId: string };
export type HotelSetupPropertyScopeRunner = <T>(
  pool: ScopePool,
  scope: HotelSetupPropertyScope,
  work: (client: ScopeClient) => Promise<T>,
) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ordinary-login equivalent of platform.hotel_setup_property_allowed (0441/0444) without the
 * login-keyed assignment (VAY-2056): READ COMMITTED, the organization row FOR UPDATE so a new
 * suspension or revocation waits for this command, and the active catalog and PMS owner links
 * FOR SHARE. Call first inside the write transaction; membership checks follow on the same client. */
export async function lockHotelSetupOrdinaryPropertyScope(
  client: ScopeQuery,
  scope: HotelSetupPropertyScope,
): Promise<boolean> {
  if (!UUID.test(scope.propertyId) || !UUID.test(scope.organizationId)) return false;
  const isolation = await client.query<{ level: string }>(
    "SELECT current_setting('transaction_isolation') AS level",
  );
  if (isolation.rows[0]?.level !== "read committed") return false;
  const organization = await client.query(
    `SELECT id FROM identity.organizations
     WHERE id=$1::uuid AND kind='hotel_group' AND status='active' FOR UPDATE`,
    [scope.organizationId],
  );
  if (organization.rows.length !== 1) return false;
  const links = await client.query(
    `SELECT 1 FROM identity.organization_resource_links catalog_link
     JOIN identity.organization_resource_links pms_link
       ON pms_link.organization_id=catalog_link.organization_id AND pms_link.product='pms'
      AND pms_link.resource_type='pms_property' AND lower(pms_link.resource_id)=$1::uuid::text
      AND pms_link.relationship='owner' AND pms_link.status='active'
     WHERE catalog_link.organization_id=$2::uuid AND catalog_link.product='hotel_catalog'
       AND catalog_link.resource_type='property' AND lower(catalog_link.resource_id)=$1::uuid::text
       AND catalog_link.relationship='owner' AND catalog_link.status='active'
     FOR SHARE OF catalog_link, pms_link`,
    [scope.propertyId, scope.organizationId],
  );
  return links.rows.length > 0;
}

/** Same contract as withHotelSetupCommandScope for the ordinary API login: the scope locks
 * are held through the command's commit. Denial throws AuthorizationError before any work. */
export const withOrdinaryHotelSetupPropertyScope: HotelSetupPropertyScopeRunner = async (
  pool,
  scope,
  work,
) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    if (!(await lockHotelSetupOrdinaryPropertyScope(client, scope))) throw new AuthorizationError();
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
