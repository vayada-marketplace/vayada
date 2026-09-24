import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertAffiliateBookingBindingCapabilities } from "./affiliateBookingBindingRoleBoundary.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");
const role = "affiliate_booking_binding_fixture";

describe.skipIf(!url)("affiliate Booking binding role (PostgreSQL)", () => {
  const owner = new pg.Client({ connectionString: url });

  beforeAll(async () => {
    await owner.connect();
    await owner.query(
      `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
         NOREPLICATION NOBYPASSRLS`,
    );
  });

  afterAll(async () => {
    await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    await owner.end();
  });

  async function withCandidate(check: () => Promise<void>) {
    await owner.query("BEGIN");
    try {
      const database = (
        await owner.query("SELECT current_database() AS name")
      ).rows[0].name.replaceAll('"', '""');
      await owner.query(`REVOKE TEMP ON DATABASE "${database}" FROM PUBLIC`);
      await owner.query(`GRANT USAGE ON SCHEMA booking,hotel_catalog TO ${role}`);
      await owner.query(
        `GRANT SELECT ON booking.affiliate_click_contexts,
          booking.affiliate_click_admissions,hotel_catalog.property_slugs TO ${role};
         GRANT EXECUTE ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID) TO ${role};
         SET LOCAL ROLE ${role}`,
      );
      await check();
    } finally {
      await owner.query("ROLLBACK");
    }
  }

  it("accepts only guarded live-binding access", async () => {
    await withCandidate(async () => {
      await expect(assertAffiliateBookingBindingCapabilities(owner)).resolves.toBeUndefined();
    });
  });

  it("rejects missing reads and direct evidence writes", async () => {
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(`REVOKE SELECT ON booking.affiliate_click_admissions FROM ${role}`);
      await owner.query(`SET LOCAL ROLE ${role}`);
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_read_capability",
      );
    });
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `GRANT INSERT ON booking.affiliate_original_booking_bindings TO ${role};
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_direct_evidence_write",
      );
    });
  });

  it("rejects delegated reads and table-definition privileges", async () => {
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `GRANT SELECT ON booking.affiliate_click_admissions TO ${role} WITH GRANT OPTION;
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_read_delegation",
      );
    });
    for (const grant of [
      `GRANT TRIGGER ON booking.affiliate_original_booking_bindings TO ${role}`,
      `GRANT REFERENCES(context_id) ON booking.affiliate_original_booking_bindings TO ${role}`,
    ]) {
      await withCandidate(async () => {
        await owner.query("RESET ROLE");
        await owner.query(`${grant}; SET LOCAL ROLE ${role}`);
        await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
          "affiliate_booking_binding_role_direct_evidence_write",
        );
      });
    }
  });

  it("rejects permission to disable ordinary triggers", async () => {
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `GRANT SET ON PARAMETER session_replication_role TO ${role};
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_ddl",
      );
    });
  });

  it("rejects delegated or public function execution", async () => {
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `GRANT EXECUTE ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID)
           TO ${role} WITH GRANT OPTION;
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_function_delegation",
      );
    });
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `GRANT EXECUTE ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID) TO PUBLIC;
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_public_execute",
      );
    });
  });

  it("rejects the capture credential's guarded commands", async () => {
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `GRANT USAGE ON SCHEMA marketplace TO ${role};
         GRANT EXECUTE ON FUNCTION marketplace.capture_affiliate_click(TEXT,TEXT,TEXT) TO ${role};
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_capture_function_execute",
      );
    });
  });

  it("rejects drifted binding and trigger function bodies", async () => {
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `CREATE OR REPLACE FUNCTION booking.bind_live_affiliate_original(
           selected_booking_id UUID,selected_context_id UUID
         )
         RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
         SET search_path=pg_catalog AS 'BEGIN RETURN TRUE; END';
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_function_boundary",
      );
    });
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `CREATE OR REPLACE FUNCTION booking.reject_affiliate_original_binding_mutation()
         RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN OLD; END';
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_trigger_boundary",
      );
    });
  });

  it("rejects a disabled predicate or changed UPDATE OF column on an immutable trigger", async () => {
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `DROP TRIGGER guest_bookings_affiliate_creation_xid_no_update
           ON booking.guest_bookings;
         CREATE TRIGGER guest_bookings_affiliate_creation_xid_no_update
           BEFORE UPDATE OF affiliate_binding_created_xid ON booking.guest_bookings
           FOR EACH ROW WHEN (FALSE)
           EXECUTE FUNCTION booking.reject_affiliate_booking_creation_xid_mutation();
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_trigger_boundary",
      );
    });
    await withCandidate(async () => {
      await owner.query("RESET ROLE");
      await owner.query(
        `DROP TRIGGER guest_bookings_affiliate_creation_xid_no_update
           ON booking.guest_bookings;
         CREATE TRIGGER guest_bookings_affiliate_creation_xid_no_update
           BEFORE UPDATE OF public_reference ON booking.guest_bookings
           FOR EACH ROW EXECUTE FUNCTION booking.reject_affiliate_booking_creation_xid_mutation();
         SET LOCAL ROLE ${role}`,
      );
      await expect(assertAffiliateBookingBindingCapabilities(owner)).rejects.toThrow(
        "affiliate_booking_binding_role_trigger_boundary",
      );
    });
  });
});
