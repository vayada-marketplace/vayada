import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AFFILIATE_CAPTURE_ROLE,
  assertAffiliateCaptureRoleHasGuardedWriteCapabilities,
  assertAffiliateCaptureRoleHasNoWriteGrants,
  assertAffiliateCaptureRoleHasVisitReadCapabilities,
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
      `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
       CREATE ROLE ${AFFILIATE_CAPTURE_ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  });
  afterAll(async () => {
    await owner.query(
      `DROP OWNED BY ${role}; DROP ROLE ${role};
       DROP OWNED BY ${AFFILIATE_CAPTURE_ROLE}; DROP ROLE ${AFFILIATE_CAPTURE_ROLE}`,
    );
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

  it("requires the exact known visit reads and protected row-lock grants", async () => {
    await withNoPublicTemp(async () => {
      const readable = [
        "marketplace.affiliate_links",
        "marketplace.affiliate_agreement_activations",
        "marketplace.affiliate_agreement_lifecycle_events",
        "marketplace.affiliate_published_terms",
        "booking.affiliate_destination_versions",
        "hotel_catalog.properties",
        "hotel_catalog.property_slugs",
        "hotel_catalog.property_domains",
        "booking.affiliate_referral_transport_certifications",
        "booking.affiliate_validation_probes",
        "booking.affiliate_validation_probe_revocations",
        "booking.affiliate_referral_production_preflights",
        "booking.affiliate_referral_production_preflight_revocations",
      ];
      const lockable = [
        "marketplace.affiliate_agreement_activations",
        "marketplace.affiliate_agreement_lifecycle_events",
        "marketplace.affiliate_published_terms",
        "booking.affiliate_destination_versions",
        "hotel_catalog.properties",
        "hotel_catalog.property_slugs",
        "booking.affiliate_referral_transport_certifications",
        "booking.affiliate_validation_probes",
        "booking.affiliate_referral_production_preflights",
      ];
      await owner.query(
        `GRANT USAGE ON SCHEMA marketplace,booking,hotel_catalog TO ${AFFILIATE_CAPTURE_ROLE}`,
      );
      await owner.query(
        `GRANT EXECUTE ON FUNCTION marketplace.capture_affiliate_click(TEXT,TEXT,TEXT),
          booking.admit_affiliate_click(TEXT,UUID,UUID) TO ${AFFILIATE_CAPTURE_ROLE}`,
      );
      await owner.query(`GRANT SELECT ON ${readable.join(",")} TO ${AFFILIATE_CAPTURE_ROLE}`);
      await owner.query(`GRANT UPDATE ON ${lockable.join(",")} TO ${AFFILIATE_CAPTURE_ROLE}`);
      await expect(
        assertAffiliateCaptureRoleHasVisitReadCapabilities(owner),
      ).resolves.toBeUndefined();

      // ENABLE ALWAYS guards remain effective even if a fresh login starts in replica mode.
      await owner.query(
        `ALTER ROLE ${AFFILIATE_CAPTURE_ROLE} SET session_replication_role=replica`,
      );
      await expect(
        assertAffiliateCaptureRoleHasVisitReadCapabilities(owner),
      ).resolves.toBeUndefined();
      await owner.query(`ALTER ROLE ${AFFILIATE_CAPTURE_ROLE} RESET session_replication_role`);

      await owner.query(
        `REVOKE SELECT ON hotel_catalog.property_domains FROM ${AFFILIATE_CAPTURE_ROLE}`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_read_allowlist",
      );
      await owner.query(
        `GRANT SELECT ON hotel_catalog.property_domains TO ${AFFILIATE_CAPTURE_ROLE}`,
      );

      await owner.query(`GRANT SELECT(id) ON identity.users TO ${AFFILIATE_CAPTURE_ROLE}`);
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_read_allowlist",
      );
      await owner.query(`REVOKE SELECT(id) ON identity.users FROM ${AFFILIATE_CAPTURE_ROLE}`);

      await owner.query(
        `GRANT SELECT ON marketplace.affiliate_links TO ${AFFILIATE_CAPTURE_ROLE} WITH GRANT OPTION`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_direct_grant",
      );
      await owner.query(
        `REVOKE GRANT OPTION FOR SELECT ON marketplace.affiliate_links FROM ${AFFILIATE_CAPTURE_ROLE}`,
      );

      await owner.query(
        `GRANT UPDATE(id) ON hotel_catalog.properties
         TO ${AFFILIATE_CAPTURE_ROLE} WITH GRANT OPTION`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_direct_grant",
      );
      await owner.query(
        `REVOKE GRANT OPTION FOR UPDATE(id) ON hotel_catalog.properties
         FROM ${AFFILIATE_CAPTURE_ROLE}`,
      );

      await owner.query(
        `GRANT SET ON PARAMETER session_replication_role TO ${AFFILIATE_CAPTURE_ROLE}`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_ddl_or_sequence",
      );
      await owner.query(
        `REVOKE SET ON PARAMETER session_replication_role FROM ${AFFILIATE_CAPTURE_ROLE}`,
      );

      await owner.query(
        `REVOKE UPDATE ON booking.affiliate_destination_versions FROM ${AFFILIATE_CAPTURE_ROLE}`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_allowlist",
      );
      await owner.query(
        `GRANT UPDATE ON booking.affiliate_destination_versions TO ${AFFILIATE_CAPTURE_ROLE}`,
      );

      await owner.query(
        `ALTER TABLE booking.affiliate_destination_versions DISABLE TRIGGER affiliate_destination_immutable`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `ALTER TABLE booking.affiliate_destination_versions ENABLE TRIGGER affiliate_destination_immutable`,
      );

      await owner.query(
        `DROP TRIGGER affiliate_destination_immutable ON booking.affiliate_destination_versions;
         CREATE TRIGGER affiliate_destination_immutable
           BEFORE UPDATE ON booking.affiliate_destination_versions
           FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation()`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `DROP TRIGGER affiliate_destination_immutable ON booking.affiliate_destination_versions;
         CREATE TRIGGER affiliate_destination_immutable
           BEFORE UPDATE OR DELETE ON booking.affiliate_destination_versions
           FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
         ALTER TABLE booking.affiliate_destination_versions
           ENABLE ALWAYS TRIGGER affiliate_destination_immutable`,
      );

      await owner.query(
        `CREATE OR REPLACE FUNCTION platform.prevent_append_only_mutation()
         RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `CREATE OR REPLACE FUNCTION platform.prevent_append_only_mutation()
         RETURNS trigger LANGUAGE plpgsql AS $function$
         BEGIN
           RAISE EXCEPTION 'platform append-only table % cannot be %', TG_TABLE_NAME, TG_OP
             USING ERRCODE = '55000';
         END;
         $function$`,
      );

      await owner.query(`ALTER TABLE hotel_catalog.property_slugs DISABLE ROW LEVEL SECURITY`);
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(`ALTER TABLE hotel_catalog.property_slugs ENABLE ROW LEVEL SECURITY`);

      await owner.query(
        `ALTER POLICY affiliate_capture_destination_lock_only
         ON hotel_catalog.property_slugs USING (false)
         WITH CHECK (current_user <> '${AFFILIATE_CAPTURE_ROLE}')`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `ALTER POLICY affiliate_capture_destination_lock_only
         ON hotel_catalog.property_slugs USING (true)
         WITH CHECK (current_user <> '${AFFILIATE_CAPTURE_ROLE}' OR true)`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `ALTER POLICY affiliate_capture_destination_lock_only
         ON hotel_catalog.property_slugs USING (true)
         WITH CHECK (current_user <> '${AFFILIATE_CAPTURE_ROLE}')`,
      );

      await owner.query(
        `CREATE POLICY affiliate_capture_forbidden_fixture
         ON hotel_catalog.property_slugs AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false)`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `DROP POLICY affiliate_capture_forbidden_fixture ON hotel_catalog.property_slugs`,
      );

      await owner.query(
        `CREATE POLICY affiliate_capture_forbidden_fixture
         ON hotel_catalog.property_slugs AS RESTRICTIVE FOR UPDATE
         TO ${AFFILIATE_CAPTURE_ROLE} USING (false)`,
      );
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `DROP POLICY affiliate_capture_forbidden_fixture ON hotel_catalog.property_slugs`,
      );

      await owner.query(`DROP POLICY affiliate_capture_compat ON hotel_catalog.property_slugs`);
      await expect(assertAffiliateCaptureRoleHasVisitReadCapabilities(owner)).rejects.toThrow(
        "affiliate_capture_role_lock_protection",
      );
      await owner.query(
        `CREATE POLICY affiliate_capture_compat
         ON hotel_catalog.property_slugs TO PUBLIC USING (true)`,
      );
      await expect(
        assertAffiliateCaptureRoleHasVisitReadCapabilities(owner),
      ).resolves.toBeUndefined();
    });
  });
});
