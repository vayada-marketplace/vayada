#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import pg from "pg";

import { parseChannexAdoptionRunnerConfig } from "../channexAdoptionRunnerConfig.js";
import { prepareLegacyHistoricalBindingPreflightInput } from "../legacyHistoricalBindingPreflightPreparation.js";
import {
  parseLegacyHistoricalBindingPreflightInput,
  runLegacyHistoricalBindingPreflight,
} from "../legacyHistoricalBindingPreflightRunner.js";

const HOST = "vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com";
const DATABASE = "vayada_target_prod";
export const PRODUCTION_PREFLIGHT_TABLES = [
  "platform.source_extraction_runs",
  "platform.source_extraction_sources",
  "platform.source_extraction_tables",
  "migration_source_auth.snapshot_rows",
  "migration_source_booking.snapshot_rows",
  "migration_source_marketplace.snapshot_rows",
  "migration_source_pms.snapshot_rows",
  "hotel_catalog.properties",
  "pms.channel_binding_claims",
  "pms.channel_connections",
] as const;
const PUBLIC_EMPTY_VIEWS = [
  "booking.pricing_runtime_effective_authority_scopes",
  "booking.pricing_runtime_effective_property_scopes",
] as const;
type Phase = "prepare" | "execute";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

export function roleName(executionId: string, phase: Phase): string {
  return `vay2017_preflight_${phase}_${executionId.replace("-", "_")}`;
}

export function roleMarker(executionId: string, phase: Phase): string {
  return `vayada:vay2017-preflight:${executionId}:${phase}`;
}

function databaseUrl(env: NodeJS.ProcessEnv): URL {
  const owner = new URL(required(env, "TARGET_DATABASE_ADMIN_URL"));
  if (
    owner.protocol !== "postgresql:" ||
    owner.hostname !== HOST ||
    owner.port !== "5432" ||
    owner.pathname !== "/postgres" ||
    owner.username !== "vayada_admin" ||
    !owner.password ||
    owner.search !== "?sslmode=require" ||
    owner.hash
  )
    throw new Error("admin_endpoint_untrusted");
  owner.pathname = `/${DATABASE}`;
  owner.search = "";
  return owner;
}

export async function cleanupRole(
  admin: pg.Client,
  executionId: string,
  phase: Phase,
): Promise<void> {
  const role = roleName(executionId, phase);
  const account = await admin.query<{
    oid: number;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolinherit: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
    marker: string | null;
  }>(
    `SELECT oid,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolinherit,rolbypassrls,
       rolreplication,shobj_description(oid,'pg_authid') AS marker
       FROM pg_roles WHERE rolname=$1`,
    [role],
  );
  if (!account.rowCount) return;
  const found = account.rows[0]!;
  if (
    !found.rolcanlogin ||
    found.rolsuper ||
    found.rolcreaterole ||
    found.rolcreatedb ||
    found.rolinherit ||
    found.rolbypassrls ||
    found.rolreplication ||
    found.marker !== roleMarker(executionId, phase)
  )
    throw new Error("reader_cleanup_unsafe");
  const dependency = await admin.query<{ membership: boolean; ownership: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1) AS membership,
       EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
         AND refobjid=$1 AND deptype='o') AS ownership`,
    [found.oid],
  );
  if (dependency.rows[0]?.membership || dependency.rows[0]?.ownership)
    throw new Error("reader_cleanup_unsafe");
  await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(role)}`);
  await admin.query(`DROP ROLE ${admin.escapeIdentifier(role)}`);
}

export async function cleanupExpiredRoles(admin: pg.Client): Promise<void> {
  const expired = await admin.query<{ rolname: string; marker: string | null }>(
    `SELECT rolname,shobj_description(oid,'pg_authid') AS marker FROM pg_roles
      WHERE rolname LIKE 'vay2017_preflight_%' AND rolvaliduntil <= clock_timestamp()`,
  );
  for (const { rolname, marker } of expired.rows) {
    const match = /^vay2017_preflight_(prepare|execute)_(\d{1,20})_(\d{1,3})$/.exec(rolname);
    if (!match) continue;
    const phase = match[1] as Phase;
    const executionId = `${match[2]}-${match[3]}`;
    if (marker === roleMarker(executionId, phase)) await cleanupRole(admin, executionId, phase);
  }
}

export async function withReader<T>(
  admin: pg.Client,
  owner: URL,
  ssl: pg.ConnectionConfig["ssl"],
  executionId: string,
  phase: Phase,
  run: (pools: { source: pg.Pool; target: pg.Pool }) => Promise<T>,
  expectedDatabase = DATABASE,
): Promise<T> {
  const role = roleName(executionId, phase);
  const password = randomBytes(36).toString("base64url");
  await cleanupRole(admin, executionId, phase);
  let provisionAttempted = false;
  try {
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT set_config('vayada.reader_password',$1,true)", [password]);
      await admin.query("SELECT set_config('vayada.reader_marker',$1,true)", [
        roleMarker(executionId, phase),
      ]);
      provisionAttempted = true;
      await admin.query(`DO $provision$
        BEGIN
          EXECUTE format(
            'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 VALID UNTIL %L',
            ${admin.escapeLiteral(role)}, current_setting('vayada.reader_password'),
            (clock_timestamp() + interval '20 minutes')::text
          );
          EXECUTE format('COMMENT ON ROLE %I IS %L', ${admin.escapeLiteral(role)}, current_setting('vayada.reader_marker'));
          EXECUTE format('ALTER ROLE %I SET default_transaction_read_only=on', ${admin.escapeLiteral(role)});
          EXECUTE format('ALTER ROLE %I SET statement_timeout=%L', ${admin.escapeLiteral(role)}, '30s');
          EXECUTE format('ALTER ROLE %I SET lock_timeout=%L', ${admin.escapeLiteral(role)}, '3s');
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${admin.escapeLiteral(role)});
        END $provision$`);
      for (const table of PRODUCTION_PREFLIGHT_TABLES) {
        await admin.query(
          `GRANT USAGE ON SCHEMA ${table.split(".")[0]} TO ${admin.escapeIdentifier(role)}`,
        );
        await admin.query(`GRANT SELECT ON ${table} TO ${admin.escapeIdentifier(role)}`);
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const readerUrl = new URL(owner);
    readerUrl.username = role;
    readerUrl.password = password;
    const options = {
      connectionString: readerUrl.toString(),
      ssl,
      options: "-c default_transaction_read_only=on -c statement_timeout=30s -c lock_timeout=3s",
      max: 1,
      connectionTimeoutMillis: 10_000,
    };
    const source = new pg.Pool(options);
    const target = new pg.Pool(options);
    try {
      const probe = await source.connect();
      try {
        const identity = await probe.query<{ ok: boolean }>(
          "SELECT current_user=$1 AND current_database()=$2 AND current_setting('default_transaction_read_only')='on' AS ok",
          [role, expectedDatabase],
        );
        if (identity.rows[0]?.ok !== true) throw new Error("reader_identity_invalid");
        const grants = await probe.query<{ relation: string }>(
          `SELECT n.nspname||'.'||c.relname AS relation
             FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE c.relkind IN ('r','p','v','m','f')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND has_table_privilege(current_user,c.oid,'SELECT') ORDER BY 1`,
        );
        if (
          grants.rows.map(({ relation }) => relation).join("\0") !==
          [...PRODUCTION_PREFLIGHT_TABLES, ...PUBLIC_EMPTY_VIEWS].sort().join("\0")
        )
          throw new Error("reader_scope_invalid");
        const publicViews = await probe.query<{ empty: boolean }>(
          `SELECT NOT EXISTS(SELECT 1 FROM booking.pricing_runtime_effective_property_scopes)
            AND NOT EXISTS(SELECT 1 FROM booking.pricing_runtime_effective_authority_scopes)
            AS empty`,
        );
        if (publicViews.rows[0]?.empty !== true)
          throw new Error("reader_public_view_scope_invalid");
        let denied = false;
        try {
          await probe.query("UPDATE hotel_catalog.properties SET id=id WHERE false");
        } catch (error) {
          denied = ["25006", "42501"].includes((error as { code?: string }).code ?? "");
        }
        if (!denied) throw new Error("reader_write_not_denied");
      } finally {
        probe.release();
      }
      return await run({ source, target });
    } finally {
      await Promise.allSettled([source.end(), target.end()]);
    }
  } finally {
    if (provisionAttempted) await cleanupRole(admin, executionId, phase);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "prepare" && mode !== "execute" && mode !== "cleanup")
    throw new Error("mode_invalid");
  const env = process.env;
  const executionId = required(env, "VAY2017_PREFLIGHT_EXECUTION_ID");
  const expectedRelease = required(env, "VAY2017_PREFLIGHT_SOURCE_SHA");
  if (!/^\d{1,20}-\d{1,3}$/.test(executionId)) throw new Error("execution_id_invalid");
  if (!/^[0-9a-f]{40}$/.test(expectedRelease)) throw new Error("source_sha_invalid");
  if (env.APPLICATION_RELEASE !== expectedRelease) throw new Error("image_source_mismatch");
  const ca = required(env, "VAYADA_DB_RDS_CA_BUNDLE");
  const owner = databaseUrl(env);
  const ssl = { ca, rejectUnauthorized: true, servername: HOST };
  const admin = new pg.Client({
    connectionString: owner.toString(),
    ssl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  await admin.connect();
  try {
    await admin.query("SET search_path=pg_catalog");
    if (mode === "cleanup") {
      await cleanupExpiredRoles(admin);
      await cleanupRole(admin, executionId, "prepare");
      await cleanupRole(admin, executionId, "execute");
      console.log(JSON.stringify({ status: "clean" }));
      return;
    }
    const signingKeyId = required(env, "VAY2017_PREFLIGHT_SIGNING_KEY_ID");
    if (mode === "prepare") {
      const input = await withReader(admin, owner, ssl, executionId, "prepare", (pools) =>
        prepareLegacyHistoricalBindingPreflightInput(pools, signingKeyId),
      );
      console.log(
        JSON.stringify({
          status: "prepared",
          inputGzipBase64: gzipSync(input, { level: 9 }).toString("base64"),
        }),
      );
      return;
    }
    const principal = required(env, "CHANNEX_ADOPTION_EXECUTION_PRINCIPAL");
    const publicKeyPem = Buffer.from(
      required(env, "VAY2017_PREFLIGHT_PUBLIC_KEY_BASE64"),
      "base64",
    ).toString("utf8");
    const config = parseChannexAdoptionRunnerConfig(
      JSON.stringify({
        environment: "production",
        allowedExecutionPrincipals: [principal],
        verificationKeys: [{ id: signingKeyId, publicKeyPem, principal }],
        approvalPrincipals: {},
        singleHumanDualAuthority: null,
      }),
      principal,
    );
    const raw = gunzipSync(
      Buffer.from(required(env, "VAY2017_PREFLIGHT_INPUT_GZIP_BASE64"), "base64"),
      { maxOutputLength: 256 * 1024 },
    ).toString("utf8");
    const input = parseLegacyHistoricalBindingPreflightInput(
      raw,
      required(env, "VAY2017_PREFLIGHT_SIGNATURE"),
      config.verificationKeys,
    );
    const report = await withReader(admin, owner, ssl, executionId, "execute", (pools) =>
      runLegacyHistoricalBindingPreflight(pools, input),
    );
    console.log(JSON.stringify({ status: "complete", report }));
  } finally {
    await admin.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    console.error(
      JSON.stringify({
        status: "failed",
        code: /^[a-z0-9_]+$/.test(message) ? message : "historical_binding_preflight_failed",
      }),
    );
    process.exitCode = 1;
  });
