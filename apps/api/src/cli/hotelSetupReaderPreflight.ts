import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  assertHotelSetupServiceReader,
  parseHotelSetupReaderDatabaseUrl,
  parseHotelSetupCommandMode,
  type HotelSetupCommandMode,
} from "../hotelSetupCommandServiceConfig.js";
import { assertHotelSetupReaderPrivileges } from "../hotelSetupReaderPrivileges.js";

/** Release-only check; the real native reader connection must own this transaction. */
export async function checkHotelSetupReader(
  client: pg.Client,
  mode: HotelSetupCommandMode = "property_commands",
) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await assertHotelSetupServiceReader(client, mode);
    await assertHotelSetupReaderPrivileges(client, mode);
    await assertHotelSetupDatabaseIsolation(client);
  } finally {
    // Never commit, create a role, grant, write an audit or invoke a hotel command.
    await client.query("ROLLBACK");
  }
}

/** Shared by native credential checks. Does not inspect or write hotel data. */
export async function assertHotelSetupDatabaseIsolation(client: pg.Client) {
  const result = await client.query<{ safe: boolean }>(`SELECT (
      pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'CONNECT')
      AND NOT pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),
        'CONNECT WITH GRANT OPTION')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE
        (d.datname=pg_catalog.current_database()
          AND pg_catalog.has_database_privilege(current_user,d.oid,'CREATE,TEMPORARY'))
        OR (d.datallowconn AND d.datname<>pg_catalog.current_database()
          AND pg_catalog.has_database_privilege(current_user,d.oid,'CONNECT,CREATE,TEMPORARY')))
      AND NOT pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET')
      AND pg_catalog.current_setting('session_replication_role')='origin'
    ) AS safe`);
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true)
    throw new Error("Hotel setup credential database isolation failed");
}

export async function runHotelSetupReaderPreflight(env: NodeJS.ProcessEnv = process.env) {
  return runHotelSetupCredentialPreflight(
    "hotel_setup_reader",
    () =>
      parseHotelSetupReaderDatabaseUrl(
        env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL ?? "",
        env.HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT ?? "",
        parseHotelSetupCommandMode(env),
      ),
    (client) => checkHotelSetupReader(client, parseHotelSetupCommandMode(env)),
  );
}

/** Explicit TLS transport and sanitized diagnostics shared by the two release checks. */
export async function runHotelSetupCredentialPreflight(
  scope: "hotel_setup_reader" | "hotel_setup_property" | "hotel_setup_creation",
  parseUrl: () => URL,
  check: (client: pg.Client) => Promise<void>,
) {
  let client: pg.Client | undefined;
  let connectionFailed = false;
  try {
    const url = parseUrl();
    // Explicit fields prevent ambient PGHOST/PGPORT/PGOPTIONS and URL SSL options
    // from replacing this connection's endpoint, trust or read-only settings.
    client = new pg.Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true },
      options: "-c default_transaction_read_only=on -c search_path=pg_catalog",
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
    });
    // pg emits idle/transport errors separately from rejected query promises.
    client.on("error", () => {
      connectionFailed = true;
    });
    await client.connect();
    if (connectionFailed) throw new Error("Reader connection unavailable");
    await check(client);
    if (connectionFailed) throw new Error("Reader connection unavailable");
    process.stdout.write(JSON.stringify({ status: "PASS", scope }) + "\n");
    return 0;
  } catch {
    // pg errors can contain credentials, SQL text, hostnames or linked data.
    process.stderr.write(
      JSON.stringify({ status: "FAIL", code: `${scope}_preflight_failed` }) + "\n",
    );
    return 1;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runHotelSetupReaderPreflight();
