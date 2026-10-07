import pg from "pg";
import {
  parseHotelSetupDatabaseUrl,
  parseHotelSetupReaderDatabaseUrl,
} from "./hotelSetupCommandServiceConfig.js";
import { runHotelSetupReaderPreflight } from "./cli/hotelSetupReaderPreflight.js";

/** First setup only, by the separate provisioner in an exclusive release window. */
export async function activateVerifiedHotelSetupReader(input: {
  adminDatabaseUrl: string;
  readerDatabaseUrl: string;
  databaseEndpoint: string;
  expectedRoleOid: number;
}) {
  let admin: pg.Client | undefined;
  let failed = false;
  let commitAttempted = false;
  let verifier = "";
  try {
    if (!Number.isInteger(input.expectedRoleOid) || input.expectedRoleOid <= 0) throw new Error();
    const reader = parseHotelSetupReaderDatabaseUrl(
      input.readerDatabaseUrl,
      input.databaseEndpoint,
    );
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
    await admin.connect();
    await admin.query(
      "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended('hotel_setup_reader_activation',0))",
    );
    await admin.query("BEGIN");
    const staged = await admin.query(
      `SELECT oid FROM pg_catalog.pg_authid r WHERE
      oid=$1::oid AND rolname='vayada_next_hotel_setup_reader'
      AND NOT rolcanlogin AND rolpassword IS NULL AND rolvaliduntil IS NULL
      AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT rolreplication AND NOT rolbypassrls
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
        WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')`,
      [input.expectedRoleOid],
    );
    if (failed || staged.rows.length !== 1) throw new Error();
    await admin.query("SELECT pg_catalog.set_config('vay1092.reader_password',$1,true)", [
      decodeURIComponent(reader.password),
    ]);
    await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format(
      'ALTER ROLE vayada_next_hotel_setup_reader LOGIN PASSWORD %L',
      pg_catalog.current_setting('vay1092.reader_password')); END $$`);
    verifier = (
      await admin.query<{ verifier: string }>(
        "SELECT rolpassword AS verifier FROM pg_catalog.pg_authid WHERE oid=$1::oid",
        [input.expectedRoleOid],
      )
    ).rows[0]!.verifier;
    if (failed || !verifier) throw new Error();
    commitAttempted = true;
    await admin.query("COMMIT");
    if (
      failed ||
      (await runHotelSetupReaderPreflight({
        HOTEL_SETUP_COMMAND_READER_DATABASE_URL: input.readerDatabaseUrl,
        HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: input.databaseEndpoint,
      })) !== 0 ||
      failed
    )
      throw new Error();
    return { roleOid: input.expectedRoleOid };
  } catch {
    await admin?.query("ROLLBACK").catch(() => undefined);
    if (commitAttempted) {
      try {
        await admin!.query("BEGIN");
        await admin!.query(
          `SELECT pg_catalog.set_config('vay1092.reader_oid',$1,true),
          pg_catalog.set_config('vay1092.reader_verifier',$2,true)`,
          [String(input.expectedRoleOid), verifier],
        );
        await admin!.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_catalog.pg_authid WHERE
            oid=pg_catalog.current_setting('vay1092.reader_oid')::oid
            AND rolname='vayada_next_hotel_setup_reader' AND NOT rolcanlogin AND rolpassword IS NULL)
          THEN RETURN; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_authid WHERE
            oid=pg_catalog.current_setting('vay1092.reader_oid')::oid
            AND rolname='vayada_next_hotel_setup_reader'
            AND rolpassword=pg_catalog.current_setting('vay1092.reader_verifier'))
          THEN RAISE EXCEPTION 'Reader activation changed'; END IF;
          ALTER ROLE vayada_next_hotel_setup_reader NOLOGIN PASSWORD NULL;
        END $$`);
        await admin!.query("COMMIT");
        if (failed) throw new Error();
      } catch {
        throw new Error("Hotel setup reader login requires recovery inspection");
      }
    }
    throw new Error("Hotel setup reader login verification failed");
  } finally {
    await admin?.end().catch(() => undefined);
  }
}
