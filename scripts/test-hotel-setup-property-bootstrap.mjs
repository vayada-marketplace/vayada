// Run inside the owned local two-root ops fixture; never points at a production database.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { checkHotelSetupPropertyCredential } from "../apps/api/dist/cli/hotelSetupPropertyPreflight.js";
const raw = process.env.HOTEL_SETUP_PROPERTY_BOOTSTRAP_TEST_DATABASE_URL;
const url = new URL(raw);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/vay1092_publication_test");
const endpoint = new URL(url);
endpoint.username = endpoint.password = endpoint.search = "";
const client = new pg.Client({ connectionString: raw });
await client.connect();
const organizationId = randomUUID(),
  actorUserId = randomUUID(),
  key = `bootstrap_${randomBytes(10).toString("hex")}`;
const properties = [],
  logins = [];
const root = mkdtempSync(join(tmpdir(), "vay1092-cli-"));
const databases = (
  await client.query(
    `SELECT datname AS name, COALESCE(array_agg(a.privilege_type) FILTER(WHERE a.grantee=0),ARRAY[]::text[]) AS privileges FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true WHERE datallowconn GROUP BY datname`,
  )
).rows;
const counts = async () =>
  (
    await client.query(
      `SELECT (SELECT count(*) FROM finance.expense_categories)::text AS categories,(SELECT count(*) FROM pms.property_pricing_settings)::text AS pricing,(SELECT count(*) FROM identity.product_entitlements)::text AS entitlements,(SELECT count(*) FROM platform.product_audit_events)::text AS audits`,
    )
  ).rows;
try {
  for (const db of databases)
    await client.query(`REVOKE ALL ON DATABASE ${client.escapeIdentifier(db.name)} FROM PUBLIC`);
  await client.query(
    `INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','CLI fixture',$2)`,
    [organizationId, key],
  );
  await client.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
    actorUserId,
    `${key}@example.test`,
  ]);
  await client.query(
    `INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode,pms_access_enabled) VALUES($1,$2,$3,'agency','all',FALSE)`,
    [organizationId, actorUserId, key],
  );
  for (const permission of [
    "hotel_catalog.setup.manage",
    "pms.operations.manage",
    "pms.finance.manage",
  ])
    await client.query(
      `INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key) VALUES('hotel_group',$1,$2)`,
      [key, permission],
    );
  await client.query(
    `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','property-management','active')`,
    [organizationId],
  );
  const before = await counts();
  for (const [operation, mode] of [
    ["launch_settings", "success"],
    ["currency", "success"],
    ["currency_ready", "success"],
    ["feature_hub", "success"],
    ["launch_settings", "secondary"],
    ["launch_settings", "publication"],
    ["launch_settings", "account"],
  ]) {
    const propertyId = randomUUID();
    properties.push(propertyId);
    if (operation !== "launch_settings")
      await client.query(
        "UPDATE identity.organization_memberships SET pms_access_enabled=TRUE WHERE user_id=$1",
        [actorUserId],
      );
    await client.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1,$1::uuid::text,'CLI fixture',$2)`,
      [propertyId, organizationId],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active'),($1,'pms','pms_property',$2,'owner','active')`,
      [organizationId, propertyId],
    );
    const run = (mode) => {
      let result;
      try {
        result = {
          status: 0,
          stdout: execFileSync(
            process.execPath,
            ["/app/apps/api/dist/cli/hotelSetupPropertyBootstrap.js"],
            {
              encoding: "utf8",
              timeout: 60_000,
              env: {
                ...process.env,
                NODE_OPTIONS:
                  "--import /app/scripts/hotel-setup-property-bootstrap.test-preload.mjs",
                AWS_ACCESS_KEY_ID: "synthetic-key",
                AWS_SECRET_ACCESS_KEY: "synthetic-secret",
                AWS_PROFILE: "",
                AWS_EC2_METADATA_DISABLED: "true",
                VAY1092_BOOTSTRAP_TEST_MODE: mode,
                VAY1092_BOOTSTRAP_TEST_RECEIPT: join(root, "receipt.json"),
                HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL: raw,
                HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: endpoint.href,
                HOTEL_SETUP_COMMAND_PROPERTY_ID: propertyId,
                HOTEL_SETUP_COMMAND_ORGANIZATION_ID: organizationId,
                HOTEL_SETUP_COMMAND_ACTOR_USER_ID: actorUserId,
                HOTEL_SETUP_COMMAND_OPERATION: operation,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
        };
      } catch (e) {
        result = { status: e.status, stdout: e.stdout, stderr: e.stderr };
      }
      assert.equal(result.status, mode === "success" ? 0 : 1);
      const receipt = JSON.parse(mode === "success" ? result.stdout : result.stderr);
      assert.equal(receipt.status, mode === "success" ? "PASS" : "FAIL");
      assert(!JSON.stringify(receipt).includes("password"));
      assert(!JSON.stringify(receipt).includes("postgresql://"));
      return { receipt, aws: JSON.parse(readFileSync(join(root, "receipt.json"), "utf8")) };
    };
    const { receipt, aws } = run(mode);
    const prefix = `vayada_next_hotel_setup_property_${createHash("sha256").update(`${propertyId}:${operation}`).digest("hex").slice(0, 16)}_`;
    const role = (
      await client.query(
        "SELECT rolname,rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE pg_catalog.left(rolname::text,length($1))=$1",
        [prefix],
      )
    ).rows;
    assert.equal(role.length, 1);
    logins.push(role[0].rolname);
    const assignments = (
      await client.query(
        "SELECT active FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
        [role[0].rolname],
      )
    ).rows;
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].active, mode === "success");
    assert.equal(role[0].rolcanlogin, mode === "success");
    assert.equal(aws.writes, ["success", "publication"].includes(mode) ? 1 : 0);
    if (mode === "success") {
      assert.equal(receipt.login, role[0].rolname);
      assert.equal(receipt.propertyId, propertyId);
      const credential = JSON.parse(aws.secret.SecretString);
      assert.deepEqual(Object.keys(credential).sort(), ["password", "username"]);
      const native = new URL(raw);
      native.username = credential.username;
      native.password = credential.password;
      const proof = new pg.Client({ connectionString: native.href });
      await proof.connect();
      try {
        await checkHotelSetupPropertyCredential(proof, { propertyId, organizationId, operation });
      } finally {
        await proof.end();
      }
      const verifier = role[0].rolpassword;
      run("duplicate");
      assert.equal(
        (
          await client.query("SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname=$1", [
            role[0].rolname,
          ])
        ).rows[0].rolpassword,
        verifier,
      );
    } else assert.equal(role[0].rolpassword, null);
    assert.deepEqual(await counts(), before);
  }
  console.log(
    "PASS: compiled fixed-root CLI four purposes, duplicate refusal, secondary/account/publication cleanup, no business writes",
  );
} finally {
  for (const login of logins) {
    await client.query("DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1", [
      login,
    ]);
    await client.query(`DROP OWNED BY ${client.escapeIdentifier(login)}`);
    await client.query(`DROP ROLE ${client.escapeIdentifier(login)}`);
  }
  await client.query("DELETE FROM identity.organization_resource_links WHERE organization_id=$1", [
    organizationId,
  ]);
  await client.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [properties]);
  await client.query("DELETE FROM identity.product_entitlements WHERE organization_id=$1", [
    organizationId,
  ]);
  await client.query("DELETE FROM identity.organization_memberships WHERE organization_id=$1", [
    organizationId,
  ]);
  await client.query("DELETE FROM identity.role_permission_grants WHERE role_key=$1", [key]);
  await client.query("DELETE FROM identity.users WHERE id=$1", [actorUserId]);
  await client.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
  for (const db of databases)
    if (db.privileges.length)
      await client.query(
        `GRANT ${db.privileges.join(",")} ON DATABASE ${client.escapeIdentifier(db.name)} TO PUBLIC`,
      );
  rmSync(root, { recursive: true, force: true });
  await client.end();
}
