import { loadServerConfig } from "@vayada/backend-config";
import type pg from "pg";
import { parseHotelSetupCredentialConfiguration } from "./hotelSetupCommandCredentials.js";

const READER_LOGIN = "vayada_next_hotel_setup_reader";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value?.trim()) throw new Error(`${key} is required`);
  return value;
}

/** Private executable only; never falls back to the ordinary API environment. */
export function loadHotelSetupCommandServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const server = loadServerConfig(env, { host: "0.0.0.0", port: 8011 });
  const internalToken = required(env, "HOTEL_SETUP_COMMAND_INTERNAL_TOKEN");
  if (Buffer.byteLength(internalToken) < 32)
    throw new Error("HOTEL_SETUP_COMMAND_INTERNAL_TOKEN must contain at least 32 bytes");
  const databaseEndpoint = required(env, "HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT");
  const secretPrefix = required(env, "HOTEL_SETUP_COMMAND_SECRET_PREFIX");
  const endpoint = parseHotelSetupCredentialConfiguration({ databaseEndpoint, secretPrefix });
  const readerDatabaseUrl = required(env, "HOTEL_SETUP_COMMAND_READER_DATABASE_URL");
  try {
    const reader = new URL(readerDatabaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(reader.protocol) ||
      decodeURIComponent(reader.username) !== READER_LOGIN ||
      Buffer.byteLength(decodeURIComponent(reader.password)) < 32 ||
      reader.hostname !== endpoint.hostname ||
      (reader.port || "5432") !== (endpoint.port || "5432") ||
      reader.pathname !== endpoint.pathname ||
      reader.hash ||
      reader.searchParams.get("sslmode") !== "verify-full" ||
      [...reader.searchParams.keys()].length !== 1
    )
      throw new Error();
  } catch {
    throw new Error("Invalid hotel setup reader database configuration");
  }
  const workosJwksUrl = required(env, "HOTEL_SETUP_COMMAND_WORKOS_JWKS_URL");
  const workosIssuer = required(env, "HOTEL_SETUP_COMMAND_WORKOS_ISSUER");
  for (const value of [workosJwksUrl, workosIssuer]) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    } catch {
      throw new Error("Hotel setup WorkOS URLs must use HTTPS without credentials");
    }
  }
  return {
    ...server,
    internalToken,
    databaseEndpoint,
    secretPrefix,
    readerDatabaseUrl,
    workosJwksUrl,
    workosIssuer,
    workosAudience: required(env, "HOTEL_SETUP_COMMAND_WORKOS_AUDIENCE"),
  };
}

/** Role posture only. Exact read/audit ACL and IAM proofs remain release gates. */
export async function assertHotelSetupServiceReader(pool: Pick<pg.Pool, "query">) {
  const result = await pool.query<{ safe: boolean }>(`SELECT (
    session_user = current_user AND role.rolname = '${READER_LOGIN}'
    AND role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolbypassrls
    AND NOT role.rolcreaterole AND NOT role.rolcreatedb AND NOT role.rolreplication
    AND NOT role.rolinherit
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = role.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
      WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND refobjid = role.oid AND deptype = 'o'
        AND (dbid = 0 OR dbid = (SELECT oid FROM pg_catalog.pg_database
          WHERE datname = pg_catalog.current_database())))
  ) AS safe FROM pg_catalog.pg_roles role WHERE role.rolname = session_user`);
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup reader role preflight failed");
}
