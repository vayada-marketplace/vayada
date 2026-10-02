import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { checkHotelSetupReader } from "./cli/hotelSetupReaderPreflight.js";
import {
  assertHotelSetupReaderPrivileges,
  HOTEL_SETUP_READER_READ_COLUMNS,
  HOTEL_SETUP_READER_AUDIT_COLUMNS,
} from "./hotelSetupReaderPrivileges.js";
import { stageHotelSetupReaderRole } from "./hotelSetupReaderRoleStaging.js";

const connectionString = process.env.HOTEL_SETUP_READER_STAGE_TEST_DATABASE_URL;

describe.runIf(connectionString)("disabled reader staging on isolated PostgreSQL", () => {
  it("stages exact grants, rejects adoption, and rolls back a failed final grant", async () => {
    const url = new URL(connectionString!);
    if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/vay1092_"))
      throw new Error("Reader staging requires an owned disposable local cluster");
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const role = "vayada_next_hotel_setup_reader";
    const provisioner = "vay1092_reader_stage_provisioner";
    const password = randomBytes(36).toString("base64url");
    const databases = (
      await admin.query<{ name: string; privileges: string[] }>(`
      SELECT d.datname AS name, COALESCE(array_agg(a.privilege_type)
        FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
    ).rows;
    let staged = false;
    let provisionerCreated = false;
    let databaseAclsChanged = false;
    const snapshot = async () =>
      (
        await admin.query(`
      SELECT r.*, (SELECT pg_catalog.json_agg(m) FROM pg_catalog.pg_auth_members m
        WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,
        (SELECT pg_catalog.json_agg(a) FROM pg_catalog.pg_attribute a
          WHERE a.attacl IS NOT NULL) AS columns
      FROM pg_catalog.pg_authid r WHERE r.rolname='${role}'`)
      ).rows;
    const setPassword = async (name: string) => {
      await admin.query("BEGIN");
      await admin.query("SELECT pg_catalog.set_config('vay1092.test_password',$1,true)", [
        password,
      ]);
      await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format('ALTER ROLE ${name} PASSWORD %L',
        pg_catalog.current_setting('vay1092.test_password')); END $$`);
      await admin.query("COMMIT");
    };
    try {
      await stageHotelSetupReaderRole({ connectionString });
      staged = true;
      expect(await snapshot()).toMatchObject([
        {
          rolcanlogin: false,
          rolinherit: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolpassword: null,
          memberships: null,
        },
      ]);
      await setPassword(role); // Even a test password must not bypass NOLOGIN.
      const readerUrl = new URL(url);
      readerUrl.username = role;
      readerUrl.password = password;
      const disabled = new pg.Client({ connectionString: readerUrl.toString() });
      try {
        await expect(disabled.connect()).rejects.toMatchObject({ code: "28000" });
      } finally {
        await disabled.end();
      }

      // Preserve even an unsafe existing role: reject instead of repairing it.
      await admin.query(`ALTER ROLE ${role} INHERIT`);
      await admin.query(`GRANT UPDATE(status) ON identity.product_entitlements TO ${role}`);
      const existing = await snapshot();
      await expect(stageHotelSetupReaderRole({ connectionString })).rejects.toMatchObject({
        code: "42710",
      });
      expect(await snapshot()).toEqual(existing);
      await admin.query(`ALTER ROLE ${role} NOINHERIT`);
      await admin.query(`REVOKE UPDATE(status) ON identity.product_entitlements FROM ${role}`);

      // Test-only activation; native authentication checks the staged effective grants.
      await admin.query(`ALTER ROLE ${role} LOGIN`);
      const reader = new pg.Client({ connectionString: readerUrl.toString() });
      await reader.connect();
      try {
        await expect(assertHotelSetupReaderPrivileges(reader)).resolves.toBeUndefined();
        // Staging does not silently rewrite PUBLIC database ACLs or claim readiness.
        await expect(checkHotelSetupReader(reader)).rejects.toThrow("database isolation failed");
        databaseAclsChanged = true;
        for (const database of databases)
          await admin.query(
            `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
          );
        await expect(checkHotelSetupReader(reader)).resolves.toBeUndefined();
        for (const sql of [
          "UPDATE identity.product_entitlements SET status=status WHERE false",
          "INSERT INTO platform.hotel_setup_property_scopes DEFAULT VALUES",
          "SELECT private_payload FROM platform.product_audit_events",
        ])
          await expect(reader.query(sql)).rejects.toMatchObject({ code: "42501" });
      } finally {
        await reader.end();
      }
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      staged = false;

      // Give the provisioner every grant option except audit INSERT. Its last
      // grant fails after role creation and all reads; nothing may survive.
      await admin.query(`CREATE ROLE ${provisioner} LOGIN CREATEROLE NOINHERIT`);
      provisionerCreated = true;
      await setPassword(provisioner);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(url.pathname.slice(1))} TO ${provisioner} WITH GRANT OPTION`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA identity,platform TO ${provisioner} WITH GRANT OPTION`,
      );
      for (const [relation, columns] of Object.entries(HOTEL_SETUP_READER_READ_COLUMNS))
        await admin.query(
          `GRANT SELECT (${columns.join(",")}) ON ${relation} TO ${provisioner} WITH GRANT OPTION`,
        );
      const provisionerUrl = new URL(url);
      provisionerUrl.username = provisioner;
      provisionerUrl.password = password;
      await expect(
        stageHotelSetupReaderRole({ connectionString: provisionerUrl.toString() }),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await snapshot()).toEqual([]);
      await admin.query(`GRANT INSERT (${HOTEL_SETUP_READER_AUDIT_COLUMNS.join(",")})
        ON platform.product_audit_events TO ${provisioner} WITH GRANT OPTION`);
      await admin.query(`REVOKE GRANT OPTION FOR CONNECT ON DATABASE
        ${admin.escapeIdentifier(url.pathname.slice(1))} FROM ${provisioner}`);
      // CONNECT without grant authority is only a PostgreSQL warning: fail closed.
      await expect(
        stageHotelSetupReaderRole({ connectionString: provisionerUrl.toString() }),
      ).rejects.toThrow("Hotel setup reader staging grants incomplete");
      expect(await snapshot()).toEqual([]);
    } finally {
      await admin.query("ROLLBACK");
      if (staged) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      if (provisionerCreated) {
        await admin.query(`DROP OWNED BY ${provisioner}`);
        await admin.query(`DROP ROLE ${provisioner}`);
      }
      if (databaseAclsChanged)
        for (const database of databases) {
          await admin.query(
            `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
          );
          if (database.privileges.length)
            await admin.query(
              `GRANT ${database.privileges.join(",")} ON DATABASE ${admin.escapeIdentifier(database.name)} TO PUBLIC`,
            );
        }
      await admin.end();
    }
  }, 60_000);
});

it("catches asynchronous admin errors and closes startup failures", () => {
  for (const mode of ["idle", "connect", "beforeCommit", "commit"]) {
    const preload = `import {createRequire} from 'node:module';
      import {EventEmitter} from 'node:events';
      const pg=createRequire(${JSON.stringify(new URL("../package.json", import.meta.url).pathname)})('pg');
      pg.Client=class extends EventEmitter {
        async connect(){
          if (${JSON.stringify(mode)}==='connect') throw new Error('synthetic-startup-error');
          if (${JSON.stringify(mode)}==='idle') queueMicrotask(()=>this.emit('error',new Error('synthetic-admin-transport-error')));
        }
        async query(sql){
          if (${JSON.stringify(mode)}==='beforeCommit' && sql.startsWith('GRANT INSERT'))
            queueMicrotask(()=>this.emit('error',new Error('synthetic-admin-transport-error')));
          if(sql==='COMMIT') {
            if (${JSON.stringify(mode)}!=='commit') throw new Error('unsafe-commit');
            queueMicrotask(()=>this.emit('error',new Error('synthetic-admin-transport-error')));
          }
          return {rows:[{name:'target'}]};
        }
        escapeIdentifier(name){return name;}
        async end(){process.stdout.write('closed');}
      };`;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "data:text/javascript," + encodeURIComponent(preload),
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {stageHotelSetupReaderRole} from ${JSON.stringify(new URL("./hotelSetupReaderRoleStaging.ts", import.meta.url).href)};
       try { await stageHotelSetupReaderRole({}); process.exitCode=2; }
       catch(error) {process.stderr.write(error.message); process.exitCode=1;}`,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("closed");
    expect(result.stderr).toBe(
      mode === "connect"
        ? "synthetic-startup-error"
        : mode === "commit"
          ? "Hotel setup reader staging commit outcome uncertain"
          : "Hotel setup reader staging connection unavailable",
    );
  }
}, 60000);
