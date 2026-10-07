import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backfillPreactivationOtaCommissions } from "./financeOtaCommissionPreactivation.js";
import {
  enqueueFinanceExpenseGeneration,
  replayFinanceExpenseGenerationJob,
  runFinanceExpenseGenerationJobs,
  runPreactivationOtaCommissionJobs,
} from "./financeExpenseGeneration.js";

const URL = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `13450000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const I = {
  property: id(1),
  other: id(2),
  organization: id(3),
  category: id(4),
  booking: id(5),
  room: id(6),
  rule: id(7),
  rootNight: id(8),
  correctionNight: id(9),
  rootCommission: id(10),
  correctionCommission: id(11),
} as const;
const NOW = "2026-08-20T12:00:00.000Z";

describe.skipIf(!URL)("OTA commission preactivation backfill (PostgreSQL)", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const pool = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 3 });

  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL!).pathname))
      throw new Error("Refusing non-test database");
    await admin.connect();
    await cleanup();
    await admin.query(`
      INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
        ('${I.property}','vay1345-preactivation','Preactivation'),
        ('${I.other}','vay1345-other','Other');
      INSERT INTO identity.organizations(id,kind,name,slug) VALUES
        ('${I.organization}','hotel_group','Preactivation','vay1345-preactivation');
      INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship)
        VALUES ('${I.organization}','pms','pms_property','${I.property}','owner');
      INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
        VALUES ('${I.organization}','pms','property-management','active','pms','pms_property','${I.property}');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES ('${I.property}','EUR');
      INSERT INTO finance.expense_categories(id,property_id,system_key,name,color) VALUES
        ('${I.category}','${I.property}','ota_commission','OTA','#111111');
      INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,check_in,check_out,currency)
        VALUES ('${I.booking}','${I.property}','vay1345','completed','2026-08-20','2026-08-21','EUR');
      INSERT INTO booking.nightly_revenue_room_scopes VALUES ('${I.property}','${I.room}');
      INSERT INTO finance.commission_rules(id,property_id,rule_scope,product,commission_type,percentage_rate,starts_at,source_system,ota_channel)
        VALUES ('${I.rule}','${I.property}','property','pms','percentage',15,'2026-01-01','finance','booking_com');
      INSERT INTO booking.nightly_revenue_evidence(id,property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,line_position,corrects_evidence_id,command_key) VALUES
        ('${I.rootNight}','${I.property}','${I.booking}','${I.room}','2026-08-20','2026-08-20','EUR',100,1,'room_night','completed','ota','exact',1,1,NULL,'vay1345-root'),
        ('${I.correctionNight}','${I.property}','${I.booking}','${I.room}','2026-08-20','2026-08-21','EUR',-20,0,'correction','corrected','ota','exact',2,1,'${I.rootNight}','vay1345-correction');
      INSERT INTO finance.ota_commission_evidence(id,booking_revenue_evidence_id,property_id,guest_booking_id,service_night,channel,currency,gross_room_amount,commission_rule_id,commission_rule_revision,percentage_rate,commission_amount,evidence_state,corrects_commission_evidence_id) VALUES
        ('${I.rootCommission}','${I.rootNight}','${I.property}','${I.booking}','2026-08-20','booking_com','EUR',100,'${I.rule}',1,15,15,'applied',NULL),
        ('${I.correctionCommission}','${I.correctionNight}','${I.property}','${I.booking}','2026-08-20','booking_com','EUR',-20,'${I.rule}',1,15,-3,'applied','${I.rootCommission}');`);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await admin.end();
  });

  it("dry-runs, projects corrections in order, replays safely, and refuses active properties", async () => {
    const options = { propertyId: I.property, limit: 1, clock: () => new Date(NOW) };
    const preview = await backfillPreactivationOtaCommissions(pool, options);
    expect(preview).toMatchObject({
      mode: "dry_run",
      pendingAtStart: 2,
      pendingAfter: 2,
      selectedEvidenceIds: [I.rootCommission],
      dispatchStates: [{ status: "undispatched", count: 2 }],
      unresolved: expect.arrayContaining([
        {
          evidenceId: I.rootCommission,
          jobId: null,
          jobStatus: null,
          dispatched: false,
          lastErrorCode: null,
        },
      ]),
    });
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM platform.jobs WHERE property_id=$1", [
          I.property,
        ])
      ).rows[0].count,
    ).toBe(0);

    await enqueueFinanceExpenseGeneration(admin as never, {
      family: "ota_commission",
      propertyId: I.property,
      commissionEvidenceId: I.correctionCommission,
      requestId: "preexisting-correction",
      correlationId: "preexisting-correction",
      causationId: id(20),
      requestedAt: NOW,
    });

    const first = await backfillPreactivationOtaCommissions(pool, { ...options, apply: true });
    expect(first).toMatchObject({
      mode: "apply",
      pendingAtStart: 2,
      pendingAfter: 1,
      counters: { succeeded: 1 },
      dispatchStates: [
        { status: "dispatched", count: 1 },
        { status: "undispatched", count: 1 },
      ],
      unresolved: expect.arrayContaining([
        {
          evidenceId: I.correctionCommission,
          jobId: expect.any(String),
          jobStatus: "pending",
          dispatched: false,
          lastErrorCode: null,
        },
      ]),
    });
    expect(
      (
        await admin.query(
          "SELECT status FROM platform.jobs WHERE property_id=$1 AND resource_id=$2",
          [I.property, I.correctionCommission],
        )
      ).rows[0].status,
    ).toBe("pending");
    await admin.query("UPDATE finance.expense_categories SET archived_at=now() WHERE id=$1", [
      I.category,
    ]);
    await expect(
      backfillPreactivationOtaCommissions(pool, { ...options, apply: true }),
    ).rejects.toThrow("ota_category_missing_or_archived");
    await admin.query("UPDATE finance.expense_categories SET archived_at=NULL WHERE id=$1", [
      I.category,
    ]);
    const second = await backfillPreactivationOtaCommissions(pool, { ...options, apply: true });
    expect(second).toMatchObject({
      mode: "apply",
      pendingAtStart: 1,
      pendingAfter: 0,
      selectedEvidenceIds: [I.correctionCommission],
      counters: { succeeded: 1 },
      dispatchStates: [{ status: "dispatched", count: 2 }],
    });
    const repeat = await backfillPreactivationOtaCommissions(pool, { ...options, apply: true });
    expect(repeat).toMatchObject({ pendingAtStart: 0, pendingAfter: 0, selectedCount: 0 });
    const expenses = await admin.query(
      "SELECT id::text,entry_kind,amount::text,source_key FROM finance.expenses WHERE property_id=$1 ORDER BY entry_kind",
      [I.property],
    );
    const rootId = expenses.rows.find((row) => row.entry_kind === "expense")?.id;
    expect(rootId).toBeTruthy();
    expect(expenses.rows).toEqual([
      {
        id: expect.any(String),
        entry_kind: "correction",
        amount: "12.0000",
        source_key: `ota_commission_evidence:${I.correctionCommission}:correct:${rootId}`,
      },
      {
        id: rootId,
        entry_kind: "expense",
        amount: "15.0000",
        source_key: `ota_commission_evidence:${I.rootCommission}`,
      },
    ]);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id=$1)",
          [I.property],
        )
      ).rows[0].count,
    ).toBe(2);

    const rootJob = await admin.query<{ id: string }>(
      "SELECT id::text FROM platform.jobs WHERE property_id=$1 AND resource_id=$2",
      [I.property, I.rootCommission],
    );
    await replayFinanceExpenseGenerationJob(
      admin as never,
      rootJob.rows[0]!.id,
      () => new Date(NOW),
    );
    await admin.query(
      "UPDATE identity.organization_resource_links SET status='suspended' WHERE organization_id=$1",
      [I.organization],
    );
    expect(
      (
        await runPreactivationOtaCommissionJobs(pool, {
          propertyId: I.property,
          evidenceIds: [I.rootCommission],
          clock: () => new Date(NOW),
        })
      ).replayed,
    ).toBe(0);
    await admin.query(
      "UPDATE identity.organization_resource_links SET status='active' WHERE organization_id=$1",
      [I.organization],
    );
    expect(
      (
        await runPreactivationOtaCommissionJobs(pool, {
          propertyId: I.property,
          evidenceIds: [I.rootCommission],
          clock: () => new Date(NOW),
        })
      ).replayed,
    ).toBe(1);

    const module = await admin.query<{ id: string }>(
      `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
        VALUES ($1,'pms','module:financials','active','pms','pms_property',$2) RETURNING id::text`,
      [I.organization, I.property],
    );
    await expect(backfillPreactivationOtaCommissions(pool, options)).rejects.toThrow(
      "financials_already_active",
    );
    await admin.query("UPDATE identity.product_entitlements SET status='suspended' WHERE id=$1", [
      module.rows[0]!.id,
    ]);
    await expect(backfillPreactivationOtaCommissions(pool, options)).resolves.toMatchObject({
      mode: "dry_run",
      pendingAfter: 0,
    });
    await admin.query("UPDATE identity.product_entitlements SET status='active' WHERE id=$1", [
      module.rows[0]!.id,
    ]);
    await replayFinanceExpenseGenerationJob(
      admin as never,
      rootJob.rows[0]!.id,
      () => new Date(NOW),
    );
    expect(
      (
        await runFinanceExpenseGenerationJobs(pool, {
          propertyId: I.property,
          limit: 1,
          clock: () => new Date(NOW),
        })
      ).replayed,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM finance.expenses WHERE property_id=$1",
          [I.property],
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM finance.expenses WHERE property_id=$1",
          [I.other],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  async function cleanup() {
    await admin.query(`BEGIN;SET LOCAL session_replication_role=replica;
      DELETE FROM platform.product_audit_events WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM platform.idempotency_keys WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id IN ('${I.property}','${I.other}'));
      DELETE FROM platform.jobs WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM finance.expense_generation_dispatches WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM finance.expenses WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM finance.ota_commission_evidence WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM booking.nightly_revenue_evidence WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM finance.commission_rules WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM finance.expense_categories WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM booking.guest_bookings WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${I.property}','${I.other}');
      DELETE FROM identity.product_entitlements WHERE organization_id='${I.organization}';
      DELETE FROM identity.organization_resource_links WHERE organization_id='${I.organization}';
      DELETE FROM identity.organizations WHERE id='${I.organization}';
      DELETE FROM hotel_catalog.properties WHERE id IN ('${I.property}','${I.other}');COMMIT`);
  }
});
