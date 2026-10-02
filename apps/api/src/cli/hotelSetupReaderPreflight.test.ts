import { spawnSync } from "node:child_process";
import { runHotelSetupPreflight } from "./hotelSetupPreflight.testHelper.js";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  HOTEL_SETUP_READER_AUDIT_COLUMNS,
  HOTEL_SETUP_READER_READ_COLUMNS,
} from "../hotelSetupReaderPrivileges.js";

const executable = new URL("./hotelSetupReaderPreflight.ts", import.meta.url);
function run(overrides: NodeJS.ProcessEnv) {
  return runHotelSetupPreflight("hotelSetupReaderPreflight", overrides);
}

it("sanitizes asynchronous pg socket errors as well as rejected queries", () => {
  const preload = `import {createRequire} from 'node:module';
    import {EventEmitter} from 'node:events';
    const pg=createRequire(${JSON.stringify(new URL("../../package.json", import.meta.url).pathname)})('pg');
    pg.Client=class extends EventEmitter {
      async connect(){queueMicrotask(()=>this.emit('error',new Error('synthetic-sensitive-diagnostic')));}
      async query(){throw new Error('synthetic-sensitive-diagnostic');}
      async end(){}
    };`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript," + encodeURIComponent(preload),
      "--import",
      "tsx",
      executable.pathname,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOTEL_SETUP_COMMAND_READER_DATABASE_URL: `postgresql://vayada_next_hotel_setup_reader:${"p".repeat(32)}@127.0.0.1/target?sslmode=verify-full`,
        HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: "postgresql://127.0.0.1/target",
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe('{"status":"FAIL","code":"hotel_setup_reader_preflight_failed"}\n');
});

it("preflight fails closed without a credential and sanitizes malformed secrets", () => {
  for (const raw of ["", "postgresql://reader:synthetic-secret@[invalid/target"]) {
    const result = run({
      HOTEL_SETUP_COMMAND_READER_DATABASE_URL: raw,
      HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: "postgresql://127.0.0.1/target",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      status: "FAIL",
      code: "hotel_setup_reader_preflight_failed",
    });
    expect(result.stderr).not.toContain("synthetic-secret");
  }
}, 30_000);

const adminUrl = process.env.HOTEL_SETUP_READER_PREFLIGHT_TEST_DATABASE_URL;
describe.runIf(adminUrl)("native reader credential on isolated PostgreSQL", () => {
  it("passes exact TLS reader, rejects PUBLIC drift/wrong login, and writes nothing", async () => {
    const url = new URL(adminUrl!);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/vay1092_") ||
      !process.env.NODE_EXTRA_CA_CERTS
    )
      throw new Error("Reader preflight needs an isolated local migrated database and test CA");
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const role = "vayada_next_hotel_setup_reader";
    const password = randomBytes(36).toString("base64url");
    const databases = (
      await admin.query<{ name: string; privileges: string[] }>(`
      SELECT d.datname AS name, COALESCE(array_agg(a.privilege_type)
        FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
    ).rows;
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    let created = false;
    try {
      await admin.query("BEGIN");
      // An existing identity is never adopted; only this test's fresh role is cleaned up.
      await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await admin.query("SELECT pg_catalog.set_config('vay1092.test_password',$1,true)", [
        password,
      ]);
      await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format('ALTER ROLE ${role} PASSWORD %L',
        pg_catalog.current_setting('vay1092.test_password')); END $$`);
      for (const database of databases)
        await admin.query(`REVOKE ALL ON DATABASE ${quote(database.name)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quote(url.pathname.slice(1))} TO ${role}`);
      await admin.query(`GRANT USAGE ON SCHEMA identity,platform TO ${role}`);
      for (const [relation, columns] of Object.entries(HOTEL_SETUP_READER_READ_COLUMNS))
        await admin.query(`GRANT SELECT (${columns.join(",")}) ON ${relation} TO ${role}`);
      await admin.query(`GRANT INSERT (${HOTEL_SETUP_READER_AUDIT_COLUMNS.join(",")})
        ON platform.product_audit_events TO ${role}`);
      await admin.query("COMMIT");
      created = true;
      const before = (
        await admin.query(`SELECT count(*)::text AS count FROM platform.product_audit_events`)
      ).rows;
      url.username = role;
      url.password = password;
      url.search = "?sslmode=verify-full";
      const endpoint = new URL(url);
      endpoint.username = endpoint.password = endpoint.search = "";
      const env = {
        HOTEL_SETUP_COMMAND_READER_DATABASE_URL: url.toString(),
        HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: endpoint.toString(),
        PGHOST: "untrusted.invalid",
        PGPORT: "1",
        PGOPTIONS: "-c role=postgres",
      };
      expect(run(env)).toMatchObject({
        status: 0,
        stderr: "",
        stdout: '{"status":"PASS","scope":"hotel_setup_reader"}\n',
      });
      await admin.query(
        `GRANT CONNECT ON DATABASE ${quote(endpoint.pathname.slice(1))} TO ${role} WITH GRANT OPTION`,
      );
      expect(run(env)).toMatchObject({ status: 1, stdout: "" });
      await admin.query(
        `REVOKE GRANT OPTION FOR CONNECT ON DATABASE ${quote(endpoint.pathname.slice(1))} FROM ${role}`,
      );
      await admin.query(
        "GRANT SELECT (private_payload) ON platform.product_audit_events TO PUBLIC",
      );
      expect(run(env)).toMatchObject({ status: 1, stdout: "" });
      await admin.query(
        "REVOKE SELECT (private_payload) ON platform.product_audit_events FROM PUBLIC",
      );
      await admin.query(
        `GRANT TEMPORARY ON DATABASE ${quote(endpoint.pathname.slice(1))} TO PUBLIC`,
      );
      expect(run(env)).toMatchObject({ status: 1, stdout: "" });
      await admin.query(
        `REVOKE TEMPORARY ON DATABASE ${quote(endpoint.pathname.slice(1))} FROM PUBLIC`,
      );
      const badPassword = new URL(url);
      badPassword.password = "wrong-password".repeat(4);
      expect(
        run({ ...env, HOTEL_SETUP_COMMAND_READER_DATABASE_URL: badPassword.toString() }).status,
      ).toBe(1);
      await admin.query(`GRANT CONNECT ON DATABASE postgres TO ${role}`);
      expect(run(env)).toMatchObject({ status: 1, stdout: "" });
      await admin.query(`REVOKE CONNECT ON DATABASE postgres FROM ${role}`);
      await admin.query(`GRANT SET ON PARAMETER session_replication_role TO ${role}`);
      expect(run(env)).toMatchObject({ status: 1, stdout: "" });
      await admin.query(`REVOKE SET ON PARAMETER session_replication_role FROM ${role}`);
      const wrong = new URL(url);
      wrong.username = "postgres";
      expect(
        run({ ...env, HOTEL_SETUP_COMMAND_READER_DATABASE_URL: wrong.toString() }).status,
      ).toBe(1);
      const untrusted = run({ ...env, NODE_EXTRA_CA_CERTS: "" });
      expect(untrusted.status).toBe(1);
      expect(untrusted.stderr).not.toContain(password);
      expect(
        (await admin.query(`SELECT count(*)::text AS count FROM platform.product_audit_events`))
          .rows,
      ).toEqual(before);
    } finally {
      await admin.query("ROLLBACK");
      if (created) {
        await admin.query(
          "REVOKE SELECT (private_payload) ON platform.product_audit_events FROM PUBLIC",
        );
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
        for (const database of databases) {
          await admin.query(`REVOKE ALL ON DATABASE ${quote(database.name)} FROM PUBLIC`);
          if (database.privileges.length)
            await admin.query(
              `GRANT ${database.privileges.join(",")} ON DATABASE ${quote(database.name)} TO PUBLIC`,
            );
        }
      }
      await admin.end();
    }
  }, 60_000);
});
