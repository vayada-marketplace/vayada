import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertAffiliateCaptureRoleHasGuardedWriteCapabilities,
  assertAffiliateCaptureRoleHasNoWriteGrants,
} from "./affiliateCaptureRoleBoundary.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");
const role = "vayada_next_affiliate_capture_fixture";

describe.skipIf(!url)("affiliate capture candidate role (PostgreSQL)", () => {
  const owner = new pg.Client({ connectionString: url });
  beforeAll(async () => {
    await owner.connect();
    await owner.query(
      `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  });
  afterAll(async () => {
    await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await owner.end();
  });

  async function withNoPublicTemp(check: () => Promise<void>) {
    await owner.query("BEGIN");
    try {
      const database = (
        await owner.query("SELECT current_database() AS name")
      ).rows[0].name.replaceAll('"', '""');
      // Keep this ACL change invisible to other integration suites.
      await owner.query(`REVOKE TEMP ON DATABASE "${database}" FROM PUBLIC`);
      await check();
    } finally {
      await owner.query("ROLLBACK");
    }
  }

  it("allows a non-owner read-only candidate, but rejects direct evidence and hotel writes", async () => {
    await withNoPublicTemp(async () => {
      await assertAffiliateCaptureRoleHasNoWriteGrants(owner, role);
      await owner.query(`GRANT SELECT ON marketplace.affiliate_links TO ${role}`);
      await assertAffiliateCaptureRoleHasNoWriteGrants(owner, role);
      for (const grant of [
        `GRANT INSERT ON marketplace.affiliate_click_occurrences TO ${role}`,
        `GRANT INSERT ON booking.affiliate_click_admissions TO ${role}`,
        `GRANT INSERT ON booking.affiliate_original_booking_bindings TO ${role}`,
        `GRANT UPDATE(id) ON hotel_catalog.properties TO ${role}`,
        `GRANT UPDATE(slug) ON hotel_catalog.property_slugs TO ${role}`,
        `GRANT SELECT(id) ON marketplace.affiliate_links TO ${role} WITH GRANT OPTION`,
      ]) {
        await owner.query(grant);
        await expect(assertAffiliateCaptureRoleHasNoWriteGrants(owner, role)).rejects.toThrow(
          "affiliate_capture_role_direct_grant",
        );
        await owner.query(`REVOKE ALL ON ${grant.split(" ON ")[1]!.split(" TO ")[0]} FROM ${role}`);
      }
    });
  });

  it("rejects role membership, owner powers and schema creation", async () => {
    await withNoPublicTemp(async () => {
      await owner.query(`CREATE ROLE affiliate_capture_fixture_group NOLOGIN`);
      await owner.query(`GRANT affiliate_capture_fixture_group TO ${role}`);
      await expect(assertAffiliateCaptureRoleHasNoWriteGrants(owner, role)).rejects.toThrow(
        "affiliate_capture_role_membership_or_owner",
      );
      await owner.query(`REVOKE affiliate_capture_fixture_group FROM ${role}`);
      await owner.query(`GRANT CREATE ON SCHEMA marketplace TO ${role}`);
      await expect(assertAffiliateCaptureRoleHasNoWriteGrants(owner, role)).rejects.toThrow(
        "affiliate_capture_role_ddl_or_sequence",
      );
      await owner.query(`REVOKE CREATE ON SCHEMA marketplace FROM ${role}`);
    });
  });

  it("requires only the two guarded capture commands without delegation", async () => {
    await withNoPublicTemp(async () => {
      await owner.query(`GRANT USAGE ON SCHEMA marketplace,booking TO ${role}`);
      await owner.query(
        `GRANT EXECUTE ON FUNCTION marketplace.capture_affiliate_click(TEXT,TEXT,TEXT),
          booking.admit_affiliate_click(TEXT,UUID,UUID) TO ${role}`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).resolves.toBeUndefined();

      await owner.query(
        `GRANT EXECUTE ON FUNCTION marketplace.capture_affiliate_click(TEXT,TEXT,TEXT)
         TO ${role} WITH GRANT OPTION`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).rejects.toThrow("affiliate_capture_role_function_delegation");
      await owner.query(
        `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
         marketplace.capture_affiliate_click(TEXT,TEXT,TEXT) FROM ${role}`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).resolves.toBeUndefined();

      await owner.query(`REVOKE USAGE ON SCHEMA booking FROM ${role}`);
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).rejects.toThrow("affiliate_capture_role_schema_usage");
      await owner.query(`GRANT USAGE ON SCHEMA booking TO ${role}`);
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).resolves.toBeUndefined();

      await owner.query(
        `GRANT EXECUTE ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID) TO PUBLIC`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).rejects.toThrow("affiliate_capture_role_public_execute");
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID) FROM PUBLIC`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).resolves.toBeUndefined();

      await owner.query(
        `CREATE FUNCTION booking.affiliate_capture_forbidden_fixture()
         RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
         AS 'SELECT true'`,
      );
      await owner.query(
        `REVOKE ALL ON FUNCTION booking.affiliate_capture_forbidden_fixture() FROM PUBLIC`,
      );
      await owner.query(
        `GRANT EXECUTE ON FUNCTION booking.affiliate_capture_forbidden_fixture() TO ${role}`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).rejects.toThrow("affiliate_capture_role_extra_security_definer");
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION booking.affiliate_capture_forbidden_fixture() FROM ${role}`,
      );
      await owner.query(`DROP FUNCTION booking.affiliate_capture_forbidden_fixture()`);
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).resolves.toBeUndefined();

      await owner.query(
        `CREATE FUNCTION booking.affiliate_capture_window_fixture()
         RETURNS bigint AS 'window_row_number' LANGUAGE internal WINDOW SECURITY DEFINER`,
      );
      await owner.query(
        `REVOKE ALL ON FUNCTION booking.affiliate_capture_window_fixture() FROM PUBLIC`,
      );
      await owner.query(
        `GRANT EXECUTE ON FUNCTION booking.affiliate_capture_window_fixture() TO ${role}`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).rejects.toThrow("affiliate_capture_role_extra_security_definer");
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION booking.affiliate_capture_window_fixture() FROM ${role}`,
      );
      await owner.query(`DROP FUNCTION booking.affiliate_capture_window_fixture()`);
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).resolves.toBeUndefined();

      await owner.query(
        `GRANT EXECUTE ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID) TO ${role}`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).rejects.toThrow("affiliate_capture_role_function_allowlist");
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID) FROM ${role}`,
      );

      await owner.query(
        `REVOKE EXECUTE ON FUNCTION booking.admit_affiliate_click(TEXT,UUID,UUID) FROM ${role}`,
      );
      await expect(
        assertAffiliateCaptureRoleHasGuardedWriteCapabilities(owner, role),
      ).rejects.toThrow("affiliate_capture_role_function_allowlist");
    });
  });
});
