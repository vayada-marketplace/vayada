import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFinancialsActivationReadiness } from "./financialsActivationReadiness.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "11380000-0000-4000-8000-000000000002";
const BOOKING = "11380000-0000-4000-8000-000000000003";
const ROOM_TYPE = "11380000-0000-4000-8000-000000000004";
const ORGANIZATION = "11380000-0000-4000-8000-000000000005";
const ROOM_1 = "11380000-0000-4000-8000-000000000006";
const ROOM_2 = "11380000-0000-4000-8000-000000000007";

describe.skipIf(!TEST_DATABASE_URL)("Financials activation readiness (PostgreSQL)", () => {
  let client: pg.Client;
  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      INSERT INTO hotel_catalog.properties(id,public_id,display_name)
      VALUES('${PROPERTY}','financials-readiness','Financials readiness');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES('${PROPERTY}','EUR');
      INSERT INTO finance.expense_categories(property_id,system_key,name,color,sort_order)
      SELECT '${PROPERTY}',key,name,color,position FROM (VALUES
        ('staff','Staff','#6366F1',10),('ota_commission','OTA commission','#F59E0B',20),
        ('utilities','Utilities','#06B6D4',30),('maintenance','Maintenance','#EF4444',40),
        ('supplies','Supplies','#8B5CF6',50),('marketing','Marketing','#EC4899',60),
        ('platform_fees','Platform fees','#64748B',70)
      ) seed(key,name,color,position)`);
  });
  afterEach(async () => {
    try {
      await client.query("ROLLBACK");
      await client.query("BEGIN; SET LOCAL session_replication_role=replica");
      await client.query("DELETE FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1", [
        BOOKING,
      ]);
      await client.query("DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id=$1", [
        PROPERTY,
      ]);
      await client.query(
        "DELETE FROM pms.operational_booking_assignments WHERE guest_booking_id=$1",
        [BOOKING],
      );
      await client.query("DELETE FROM booking.guest_bookings WHERE id=$1", [BOOKING]);
      await client.query("DELETE FROM identity.product_entitlements WHERE organization_id=$1", [
        ORGANIZATION,
      ]);
      await client.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
        [ORGANIZATION],
      );
      await client.query("DELETE FROM identity.organizations WHERE id=$1", [ORGANIZATION]);
      await client.query("DELETE FROM finance.expense_categories WHERE property_id=$1", [PROPERTY]);
      await client.query("DELETE FROM pms.property_pricing_settings WHERE property_id=$1", [
        PROPERTY,
      ]);
      await client.query("DELETE FROM pms.rooms WHERE property_id=$1", [PROPERTY]);
      await client.query("DELETE FROM pms.room_types WHERE id=$1", [ROOM_TYPE]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [PROPERTY]);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  });

  it("executes the complete audit query against the target schema", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await runFinancialsActivationReadiness(client, {
      propertyId: PROPERTY,
      expectedModuleState: "inactive",
    });
    expect(report).toMatchObject({
      status: "ready",
      actualModuleState: "inactive",
      summary: { missingCategories: 0, eligibleBookings: 0, blockers: 0 },
    });
    await client.query("COMMIT");
  });

  it("reports missing seeds, revenue, and attribution from real rows", async () => {
    await client.query(
      "DELETE FROM finance.expense_categories WHERE property_id=$1 AND system_key='staff'",
      [PROPERTY],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,check_in,check_out,
         room_count,currency,total_amount,balance_amount,booking_channel)
       VALUES($1,$2,'VAY-1138-READINESS','migration','legacy-vay-1138','confirmed','2026-09-01','2026-09-03',
         2,'EUR',100,100,'unknown')`,
      [BOOKING, PROPERTY],
    );
    await client.query(
      "INSERT INTO pms.room_types(id,property_id,name,base_rate_amount,currency) VALUES($1,$2,'Readiness room',0,'EUR')",
      [ROOM_TYPE, PROPERTY],
    );
    await client.query("INSERT INTO booking.nightly_revenue_room_scopes VALUES($1,$2)", [
      PROPERTY,
      ROOM_TYPE,
    ]);
    await client.query(
      `INSERT INTO pms.operational_booking_assignments
        (property_id,guest_booking_id,room_type_id,position,stay_evidence_kind)
       VALUES($1,$2,$3,1,'summary_only'),($1,$2,$3,2,'summary_only')`,
      [PROPERTY, BOOKING, ROOM_TYPE],
    );
    await client.query(
      `INSERT INTO booking.nightly_revenue_evidence
        (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,
         occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,
         source_revision,line_position,command_key)
       VALUES($1,$2,$3,'2026-09-01','2026-09-01','EUR',50,1,'room_night','confirmed',
         'migration','exact',1,1,'vay-1138-partial')`,
      [PROPERTY, BOOKING, ROOM_TYPE],
    );
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await runFinancialsActivationReadiness(client, { propertyId: PROPERTY });
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "DEFAULT_CATEGORIES_MISSING", count: 1 }),
      expect.objectContaining({ code: "STAY_SCOPE_INCOMPLETE", count: 1 }),
      expect.objectContaining({ code: "REVENUE_BACKFILL_INCOMPLETE", count: 1 }),
      expect.objectContaining({ code: "ATTRIBUTION_UNKNOWN", count: 1 }),
    ]);
    await client.query("COMMIT");
  });

  it("requires a room-night line for each exact assignment position", async () => {
    await client.query(
      `INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,check_in,check_out,
         room_count,currency,total_amount,balance_amount,booking_channel,direct_booking_source)
       VALUES($1,$2,'VAY-1138-ROOM-POSITIONS','migration','legacy-vay-1138-rooms','confirmed',
         '2026-09-01','2026-09-02',2,'EUR',100,100,'direct','booking_engine')`,
      [BOOKING, PROPERTY],
    );
    await client.query(
      "INSERT INTO pms.room_types(id,property_id,name,base_rate_amount,currency) VALUES($1,$2,'Readiness room',0,'EUR')",
      [ROOM_TYPE, PROPERTY],
    );
    await client.query(
      `INSERT INTO pms.rooms(id,property_id,room_type_id,room_number)
       VALUES($1,$3,$4,'Readiness 1'),($2,$3,$4,'Readiness 2')`,
      [ROOM_1, ROOM_2, PROPERTY, ROOM_TYPE],
    );
    await client.query("INSERT INTO booking.nightly_revenue_room_scopes VALUES($1,$2)", [
      PROPERTY,
      ROOM_TYPE,
    ]);
    await client.query(
      `INSERT INTO pms.operational_booking_assignments
        (property_id,guest_booking_id,room_type_id,room_id,position,source,stay_evidence_kind,
         check_in,check_out,adults,children)
       VALUES($1,$2,$3,$4,1,'migration','exact','2026-09-01','2026-09-02',2,0),
             ($1,$2,$3,$5,2,'migration','exact','2026-09-01','2026-09-02',2,0)`,
      [PROPERTY, BOOKING, ROOM_TYPE, ROOM_1, ROOM_2],
    );
    await client.query(
      `INSERT INTO booking.nightly_revenue_evidence
        (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,
         occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,
         source_revision,line_position,command_key)
       VALUES($1,$2,$3,'2026-09-01','2026-09-01','EUR',50,1,'room_night','confirmed',
         'migration','exact',1,1,'vay-1138-first-room-only')`,
      [PROPERTY, BOOKING, ROOM_TYPE],
    );

    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await runFinancialsActivationReadiness(client, { propertyId: PROPERTY });
    expect(report.summary).toMatchObject({
      assignmentCoverageGaps: 0,
      missingRevenueLines: 1,
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "REVENUE_BACKFILL_INCOMPLETE", count: 1 }),
    );
    await client.query("COMMIT");
  });

  it("matches effective runtime entitlement and suspension semantics", async () => {
    await client.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Readiness org','vay-1138-readiness')",
      [ORGANIZATION],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links
        (organization_id,product,resource_type,resource_id,relationship)
       VALUES($1,'pms','pms_property',$2,'owner')`,
      [ORGANIZATION, PROPERTY],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status)
       VALUES($1,'pms','property-management','active'),($1,'pms','module:financials','active')`,
      [ORGANIZATION],
    );
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(
      await runFinancialsActivationReadiness(client, {
        propertyId: PROPERTY,
        expectedModuleState: "active",
      }),
    ).toMatchObject({ status: "ready", actualModuleState: "active" });
    await client.query("COMMIT");

    await client.query(
      `INSERT INTO identity.product_entitlements
        (organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
       VALUES($1,'pms','module:financials','suspended','pms','pms_property',$2)`,
      [ORGANIZATION, PROPERTY],
    );
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(await runFinancialsActivationReadiness(client, { propertyId: PROPERTY })).toMatchObject({
      status: "ready",
      actualModuleState: "inactive",
    });
    await client.query("COMMIT");
  });
});
