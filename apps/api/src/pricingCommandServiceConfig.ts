import { loadServerConfig } from "@vayada/backend-config";
import pg from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PricingCommandServiceConfig = {
  host: string;
  port: number;
  internalToken: string;
  propertyId: string;
  hotelSlug: string;
  authDatabaseUrl: string;
  ownerReadDatabaseUrl: string;
  ownerManageDatabaseUrl: string;
  publicDatabaseUrl: string;
  workosJwksUrl: string;
  workosIssuer: string;
  workosAudience: string;
};

type PricingScopeQuery = {
  query<T>(text: string): Promise<{ rows: T[] }>;
};

type PricingCommandDatabaseScope = {
  propertyId: string;
  operationClass: "owner_read" | "owner_manage" | "public";
  organizationId?: string;
};

export type PricingCommandEffectiveScope = {
  propertyId: string;
  organizationId: string;
};

async function assertPricingCommandDatabaseScope(
  executor: PricingScopeQuery,
  expected: PricingCommandDatabaseScope,
): Promise<PricingCommandEffectiveScope> {
  const result = await executor.query<{
    sessionUser: string;
    currentUser: string;
    operationClass: string;
    propertyId: string;
    organizationId: string;
  }>(`SELECT session_user::text AS "sessionUser", current_user::text AS "currentUser",
    operation_class AS "operationClass", property_id::text AS "propertyId",
    organization_id::text AS "organizationId"
    FROM booking.pricing_runtime_effective_property_scopes`);
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (
    !row ||
    row.sessionUser !== row.currentUser ||
    !row.sessionUser.startsWith("vayada_next_pricing_") ||
    row.operationClass !== expected.operationClass ||
    row.propertyId.toLowerCase() !== expected.propertyId.toLowerCase() ||
    !UUID.test(row.organizationId) ||
    (expected.organizationId !== undefined &&
      row.organizationId.toLowerCase() !== expected.organizationId.toLowerCase())
  )
    throw new Error("Pricing command database scope preflight failed");
  return { propertyId: row.propertyId, organizationId: row.organizationId };
}

export const assertPricingCommandPoolScope = assertPricingCommandDatabaseScope;

export async function assertPricingCommandTransactionScope(
  client: PricingScopeQuery,
  expected: PricingCommandDatabaseScope,
): Promise<PricingCommandEffectiveScope> {
  await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  return assertPricingCommandDatabaseScope(client, expected);
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value?.trim()) throw new Error(`${key} is required`);
  return value;
}

function databaseUser(connectionString: string, key: string): string {
  let user: string | undefined;
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
    user = new pg.Client({ connectionString }).user;
  } catch {
    throw new Error(`${key} must be a PostgreSQL connection URL`);
  }
  if (!user) throw new Error(`${key} must name a PostgreSQL user`);
  return user;
}

/** Loads only the private service's environment; the ordinary API never calls this. */
export function loadPricingCommandServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): PricingCommandServiceConfig {
  const server = loadServerConfig(env, { host: "0.0.0.0", port: 8010 });
  const internalToken = required(env, "PRICING_COMMAND_INTERNAL_TOKEN");
  const propertyId = required(env, "PRICING_COMMAND_PROPERTY_ID").toLowerCase();
  const hotelSlug = required(env, "PRICING_COMMAND_HOTEL_SLUG");
  const authDatabaseUrl = required(env, "PRICING_COMMAND_AUTH_DATABASE_URL");
  const ownerReadDatabaseUrl = required(env, "PRICING_COMMAND_OWNER_READ_DATABASE_URL");
  const ownerManageDatabaseUrl = required(env, "PRICING_COMMAND_OWNER_MANAGE_DATABASE_URL");
  const publicDatabaseUrl = required(env, "PRICING_COMMAND_PUBLIC_DATABASE_URL");
  if (Buffer.byteLength(internalToken) < 32)
    throw new Error("PRICING_COMMAND_INTERNAL_TOKEN must contain at least 32 bytes");
  if (!UUID.test(propertyId)) throw new Error("PRICING_COMMAND_PROPERTY_ID must be a UUID");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(hotelSlug) || hotelSlug.length > 200)
    throw new Error("PRICING_COMMAND_HOTEL_SLUG must be a canonical slug");

  const users = [
    databaseUser(authDatabaseUrl, "PRICING_COMMAND_AUTH_DATABASE_URL"),
    databaseUser(ownerReadDatabaseUrl, "PRICING_COMMAND_OWNER_READ_DATABASE_URL"),
    databaseUser(ownerManageDatabaseUrl, "PRICING_COMMAND_OWNER_MANAGE_DATABASE_URL"),
    databaseUser(publicDatabaseUrl, "PRICING_COMMAND_PUBLIC_DATABASE_URL"),
  ];
  if (
    users[0]!.startsWith("vayada_next_pricing_") ||
    users.slice(1).some((user) => !user.startsWith("vayada_next_pricing_"))
  )
    throw new Error(
      "Pricing command operation databases must use pricing-scoped PostgreSQL users only",
    );
  if (new Set(users).size !== users.length)
    throw new Error("Pricing command databases must use distinct PostgreSQL users");

  return {
    ...server,
    internalToken,
    propertyId,
    hotelSlug,
    authDatabaseUrl,
    ownerReadDatabaseUrl,
    ownerManageDatabaseUrl,
    publicDatabaseUrl,
    workosJwksUrl: required(env, "PRICING_COMMAND_WORKOS_JWKS_URL"),
    workosIssuer: required(env, "PRICING_COMMAND_WORKOS_ISSUER"),
    workosAudience: required(env, "PRICING_COMMAND_WORKOS_AUDIENCE"),
  };
}
