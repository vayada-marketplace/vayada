import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyChannexHandover,
  planChannexHandover,
  type ChannexHandoverInput,
} from "./channexHandover.js";

const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

// VAY-2108: a VAY-1362 fix A handover-pending cohort hotel (case H), promoted and reverted.
const PROPERTY = "21081000-0000-4000-8000-000000000001";
const PMS_HOTEL = "21081000-0000-4000-8000-0000000000aa";
const EXTERNAL = "21081000-0000-4000-8000-0000000000ee";
const RUN = "vay1351-2108000000000000000000aa";
const [ROOM, CLOSED_ROOM, OTHER_ROOM] = ["b1", "b2", "b3"].map(
  (n) => `21081000-0000-4000-8000-0000000000${n}`,
);
const [RATE, OTHER_RATE] = ["c1", "c2"].map((n) => `21081000-0000-4000-8000-0000000000${n}`);
const [MAP_LIVE, MAP_CLOSED, MAP_SOURCE_OFF] = ["d1", "d2", "d3"].map(
  (n) => `21081000-0000-4000-8000-0000000000${n}`,
);
const [RATE_LIVE, RATE_SOURCE_OFF] = ["e1", "e2"].map(
  (n) => `21081000-0000-4000-8000-0000000000${n}`,
);
const [BOOKING_ASSIGNED, BOOKING_UNASSIGNED] = ["f1", "f2"].map(
  (n) => `21081000-0000-4000-8000-0000000000${n}`,
);
const GUEST_BOOKING = "21081000-0000-4000-8000-000000000099";
const OTHER = "21081000-0000-4000-8000-0000000000a2";
const activate: ChannexHandoverInput = {
  command: "activate",
  propertyId: PROPERTY,
  approvalRef: "VAY-2108 handover test",
  legacyDisabledAt: "2026-10-10T08:00:00.000Z",
  legacyReadbackSha256: "a".repeat(64),
};
const revoke: ChannexHandoverInput = {
  command: "revoke",
  propertyId: PROPERTY,
  approvalRef: "VAY-2108 handover test",
  reason: "Rehearsed rollback",
};

describe.skipIf(!URL)("Channex handover executor (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 2 });

  let createdCohortTable = false;
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    // The stand-in for #2962's table must not outlive this suite on a reused test database.
    if (createdCohortTable) await db.query("DROP TABLE platform.production_migration_cohorts");
    await db.end();
  });

  it("refuses anything but a handover-pending cohort hotel", async () => {
    const metadata = (patch: string) =>
      `UPDATE pms.channel_connections SET connection_metadata = connection_metadata || '${patch}'::jsonb WHERE property_id = $1`;
    const refusals: Array<[string, string, unknown[]]> = [
      ["handover_not_pending", metadata('{"channexHandover":"completed"}'), [PROPERTY]],
      [
        "connection_not_pending",
        `UPDATE pms.channel_connections SET connection_status = 'setup_incomplete' WHERE property_id = $1`,
        [PROPERTY],
      ],
      ["cohort_stamp_missing", metadata('{"migrationCohortRunId":null}'), [PROPERTY]],
      [
        "cohort_membership_missing",
        `UPDATE hotel_catalog.property_source_links SET status = 'superseded' WHERE property_id = $1`,
        [PROPERTY],
      ],
      // Case V: a historical claim needs the VAY-2017 transition first.
      [
        "claim_exists",
        `INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source) VALUES ($1, 'channex', $2, 'historical', 'migration')`,
        [PROPERTY, EXTERNAL],
      ],
      [
        "claim_conflict",
        `WITH p AS (INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, 'vay-2108-other', 'Other') RETURNING id) INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source) SELECT id, 'channex', $2, 'historical', 'migration' FROM p`,
        [OTHER, EXTERNAL],
      ],
      [
        "reserved_identity",
        metadata('{"legacyExternalPropertyId":"8f4c1e47-3de1-4150-8bde-ad031a013842"}'),
        [PROPERTY],
      ],
      ["capabilities_invalid", metadata('{"legacyCapabilities":["booking","sell"]}'), [PROPERTY]],
      [
        "management_job_running",
        `INSERT INTO platform.jobs (job_key, queue_name, job_type, status, attempts_count, locked_at, locked_by, tenant_scope, property_id) VALUES ('vay-2108-running', 'pms.channex.management', 'channex.sync_ari', 'running', 1, now(), 'fixture', 'property', $1)`,
        [PROPERTY],
      ],
    ];
    for (const [code, sql, values] of refusals) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql, values);
        await expect(planChannexHandover(client, activate), code).rejects.toThrow(code);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    await expect(plan({ ...activate, legacyDisabledAt: "2026-10-10 08:00" })).rejects.toThrow(
      "legacy_disabled_at_invalid",
    );
    await expect(plan(revoke)).rejects.toThrow("handover_claim_missing");
    await expect(applyChannexHandover(db, activate, "0".repeat(64))).rejects.toThrow(
      "plan_changed",
    );
    expect(await claims()).toEqual([]);
  });

  it("rolls the whole activation back when any step fails", async () => {
    const { planSha256 } = await plan(activate);
    const before = { connection: await connection(), mappings: await mappingStates() };
    await db.query(`CREATE FUNCTION pms.vay2108_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'vay2108 forced failure'; END $$`);
    await db.query(`CREATE TRIGGER vay2108_fail BEFORE UPDATE ON pms.channel_booking_mappings
      FOR EACH ROW EXECUTE FUNCTION pms.vay2108_fail()`);
    try {
      await expect(applyChannexHandover(db, activate, planSha256)).rejects.toThrow(
        "vay2108 forced failure",
      );
    } finally {
      await db.query("DROP TRIGGER vay2108_fail ON pms.channel_booking_mappings");
      await db.query("DROP FUNCTION pms.vay2108_fail()");
    }
    expect(await claims()).toEqual([]);
    expect(await connection()).toEqual(before.connection);
    expect(await mappingStates()).toEqual(before.mappings);
  });

  it("activates the claim, the connection and the eligible mappings in one audited step", async () => {
    const before = { connection: await connection(), stamps: await mappingStamps() };
    const { planSha256 } = await plan(activate);
    const result = await applyChannexHandover(db, activate, planSha256);
    expect(await claims()).toEqual([{ state: "active", source: "handover", external: EXTERNAL }]);
    const after = await connection();
    expect(after).toMatchObject({
      status: "connected",
      external: EXTERNAL,
      capabilities: ["booking", "ari", "message"],
      messaging: true,
    });
    expect(after.metadata).toMatchObject({
      channexHandover: "completed",
      migrationCohortRunId: RUN,
    });
    expect(after.generation).not.toBe(before.connection.generation);
    expect(after.updatedAt > before.connection.updatedAt).toBe(true);
    expect(await mappingStates()).toEqual({
      [MAP_LIVE]: "active",
      [MAP_CLOSED]: "disabled",
      [MAP_SOURCE_OFF]: "disabled",
      [RATE_LIVE]: "active",
      [RATE_SOURCE_OFF]: "disabled",
      [BOOKING_ASSIGNED]: "active",
      [BOOKING_UNASSIGNED]: "ignored",
    });
    // Every changed row carries a new updated_at, so an import re-run sees the promotion.
    const stamps = await mappingStamps();
    for (const id of [MAP_LIVE, RATE_LIVE, BOOKING_ASSIGNED])
      expect(stamps[id]! > before.stamps[id]!, id).toBe(true);
    for (const id of [MAP_CLOSED, MAP_SOURCE_OFF, RATE_SOURCE_OFF, BOOKING_UNASSIGNED])
      expect(stamps[id], id).toBe(before.stamps[id]);
    const audit = await db.query(
      `SELECT action, actor_type, tenant_scope, target_resource_id AS target,
         redacted_payload->'roomTypeMappingIds' AS rooms, audit_metadata ? 'sessionUser' AS session
       FROM platform.product_audit_events WHERE id = $1::uuid`,
      [result.auditId],
    );
    expect(audit.rows[0]).toEqual({
      action: "pms.channex.handover.activated",
      actor_type: "migration",
      tenant_scope: "property",
      target: PROPERTY,
      rooms: [MAP_LIVE],
      session: true,
    });
    await expect(applyChannexHandover(db, activate, planSha256)).rejects.toThrow(
      "handover_not_pending",
    );
  });

  it("revokes everything live on the binding, also rows written after activation", async () => {
    // Written by the target after the handover: the revoke must disable these too.
    await db.query(`UPDATE pms.channel_booking_mappings SET sync_status = 'active' WHERE id = $1`, [
      BOOKING_UNASSIGNED,
    ]);
    await db.query(`UPDATE pms.channel_room_type_mappings SET status = 'active' WHERE id = $1`, [
      MAP_SOURCE_OFF,
    ]);
    await db.query(
      `UPDATE pms.channel_connections SET connection_metadata = connection_metadata
         || '{"connectedChannels":["booking_com"],"inventoryRules":{}}'::jsonb WHERE property_id = $1`,
      [PROPERTY],
    );
    const before = await connection();
    await expect(applyChannexHandover(db, revoke, "0".repeat(64))).rejects.toThrow("plan_changed");
    const { planSha256 } = await plan(revoke);
    await applyChannexHandover(db, revoke, planSha256);
    expect(await claims()).toEqual([{ state: "released", source: "handover", external: EXTERNAL }]);
    const after = await connection();
    expect(after).toMatchObject({
      status: "disconnected",
      external: null,
      capabilities: [],
      messaging: false,
    });
    expect(after.metadata).toMatchObject({ channexHandover: "pending", migrationCohortRunId: RUN });
    expect(after.metadata).not.toHaveProperty("connectedChannels");
    expect(after.metadata).not.toHaveProperty("inventoryRules");
    expect(after.generation).not.toBe(before.generation);
    expect(Object.values(await mappingStates())).toEqual([
      "disabled",
      "disabled",
      "disabled",
      "disabled",
      "disabled",
      "ignored",
      "ignored",
    ]);
  });

  it("reactivates the released claim and can revoke after the connection lost its id", async () => {
    const again = await plan(activate);
    expect(again.plan.claimId).not.toBeNull();
    await applyChannexHandover(db, activate, again.planSha256);
    expect(await claims()).toEqual([{ state: "active", source: "handover", external: EXTERNAL }]);
    // A disable job clears the id but leaves the claim; revoke must still release it.
    await db.query(
      `UPDATE pms.channel_connections SET external_property_id = NULL, connection_status = 'disconnected'
       WHERE property_id = $1`,
      [PROPERTY],
    );
    const { planSha256 } = await plan(revoke);
    await applyChannexHandover(db, revoke, planSha256);
    expect(await claims()).toEqual([{ state: "released", source: "handover", external: EXTERNAL }]);
  });

  async function plan(input: ChannexHandoverInput) {
    const client = await db.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      return await planChannexHandover(client, input);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function claims() {
    return (
      await db.query(
        `SELECT claim_state AS state, claim_source AS source, external_property_id AS external
         FROM pms.channel_binding_claims WHERE property_id = $1 OR external_property_id = $2`,
        [PROPERTY, EXTERNAL],
      )
    ).rows;
  }

  async function connection() {
    return (
      await db.query(
        `SELECT connection_status AS status, external_property_id AS external, capabilities,
           messaging_app_installed AS messaging, connection_metadata AS metadata,
           binding_generation::text AS generation, updated_at::text AS "updatedAt"
         FROM pms.channel_connections WHERE property_id = $1`,
        [PROPERTY],
      )
    ).rows[0];
  }

  async function mappingStates() {
    const rows = await db.query<{ id: string; state: string }>(
      `SELECT id::text, status AS state, 1 AS kind FROM pms.channel_room_type_mappings WHERE property_id = $1
       UNION ALL SELECT id::text, status, 2 FROM pms.channel_rate_plan_mappings WHERE property_id = $1
       UNION ALL SELECT id::text, sync_status, 3 FROM pms.channel_booking_mappings WHERE property_id = $1
       ORDER BY kind, id`,
      [PROPERTY],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.id, row.state]));
  }

  async function mappingStamps() {
    const rows = await db.query<{ id: string; stamp: string }>(
      `SELECT id::text, updated_at::text AS stamp FROM pms.channel_room_type_mappings WHERE property_id = $1
       UNION ALL SELECT id::text, updated_at::text FROM pms.channel_rate_plan_mappings WHERE property_id = $1
       UNION ALL SELECT id::text, updated_at::text FROM pms.channel_booking_mappings WHERE property_id = $1`,
      [PROPERTY],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.id, row.stamp]));
  }

  async function seed() {
    // Until #2962 (VAY-1362) lands platform.production_migration_cohorts, a stand-in with its columns.
    createdCohortTable = !(
      await db.query("SELECT to_regclass('platform.production_migration_cohorts') AS t")
    ).rows[0].t;
    if (createdCohortTable)
      await db.query(
        `CREATE TABLE platform.production_migration_cohorts (
           source_run_id TEXT PRIMARY KEY, cohort_sha256 TEXT NOT NULL, booking_hotel_ids UUID[] NOT NULL,
           pms_hotel_ids UUID[] NOT NULL, marketplace_hotel_ids UUID[] NOT NULL,
           approval_proof_sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
    await db.query(
      `INSERT INTO platform.production_migration_cohorts
         (source_run_id, cohort_sha256, booking_hotel_ids, pms_hotel_ids, marketplace_hotel_ids, approval_proof_sha256)
       VALUES ($1, $2, ARRAY[$3::uuid], ARRAY[$4::uuid], '{}', $2)`,
      [RUN, "b".repeat(64), PROPERTY, PMS_HOTEL],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, 'vay-2108-handover', 'VAY-2108 handover')",
      [PROPERTY],
    );
    await db.query(
      `INSERT INTO hotel_catalog.property_source_links (property_id, source_system, source_table, source_id, relationship)
       VALUES ($1, 'pms', 'hotels', $2, 'operational_input')`,
      [PROPERTY, PMS_HOTEL],
    );
    for (const room of [ROOM, CLOSED_ROOM, OTHER_ROOM])
      await db.query(
        "INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency, active) VALUES ($1, $2, $4, 0, 'EUR', $3)",
        [room, PROPERTY, room !== CLOSED_ROOM, `room ${room.slice(-2)}`],
      );
    for (const [rate, room] of [
      [RATE, ROOM],
      [OTHER_RATE, OTHER_ROOM],
    ])
      await db.query(
        "INSERT INTO pms.rate_plans (id, property_id, room_type_id, code, currency, name) VALUES ($1, $2, $3, $4, 'EUR', 'Rate')",
        [rate, PROPERTY, room, `rate-${rate.slice(-2)}`],
      );
    const connectionId = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.channel_connections (property_id, provider, connection_status, connection_metadata)
         VALUES ($1, 'channex', 'disconnected', $2::jsonb) RETURNING id::text`,
        [
          PROPERTY,
          JSON.stringify({
            migrationRunId: RUN,
            migrationCohortRunId: RUN,
            channexHandover: "pending",
            legacyExternalPropertyId: EXTERNAL,
            legacyCapabilities: ["booking", "ari", "message"],
            ownerStatus: "active",
            retainedClaimState: null,
          }),
        ],
      )
    ).rows[0]!.id;
    const flags = (sourceActive: boolean) => JSON.stringify({ sourceActive, roomTypeActive: true });
    for (const [id, room, external, sourceActive] of [
      [MAP_LIVE, ROOM, "x-room-1", true],
      [MAP_CLOSED, CLOSED_ROOM, "x-room-2", true],
      [MAP_SOURCE_OFF, OTHER_ROOM, "x-room-3", false],
    ] as const)
      await db.query(
        `INSERT INTO pms.channel_room_type_mappings (id, property_id, connection_id, room_type_id, external_room_type_id, status, mapping_metadata)
         VALUES ($1, $2, $3, $4, $5, 'disabled', $6::jsonb)`,
        [id, PROPERTY, connectionId, room, external, flags(sourceActive)],
      );
    for (const [id, rate, room, external, sourceActive] of [
      [RATE_LIVE, RATE, ROOM, "x-rate-1", true],
      [RATE_SOURCE_OFF, OTHER_RATE, OTHER_ROOM, "x-rate-2", false],
    ] as const)
      await db.query(
        `INSERT INTO pms.channel_rate_plan_mappings (id, property_id, connection_id, room_type_id, rate_plan_id, external_room_type_id, external_rate_plan_id, status, mapping_metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'disabled', $8::jsonb)`,
        [id, PROPERTY, connectionId, room, rate, `${external}-room`, external, flags(sourceActive)],
      );
    await db.query(
      `INSERT INTO booking.guest_bookings (id, property_id, public_reference, source_system, source_booking_id,
         lifecycle_status, check_in, check_out, room_count, currency, total_amount, balance_amount, booking_channel)
       VALUES ($1, $2, 'VAY-2108-HANDOVER', 'migration', 'legacy-vay-2108', 'confirmed', '2026-11-01', '2026-11-03', 1, 'EUR', 100, 100, 'unknown')`,
      [GUEST_BOOKING, PROPERTY],
    );
    await db.query("INSERT INTO booking.nightly_revenue_room_scopes VALUES ($1, $2)", [
      PROPERTY,
      ROOM,
    ]);
    const assignment = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.operational_booking_assignments (property_id, guest_booking_id, room_type_id, position, stay_evidence_kind)
         VALUES ($1, $2, $3, 1, 'summary_only') RETURNING id::text`,
        [PROPERTY, GUEST_BOOKING, ROOM],
      )
    ).rows[0]!.id;
    for (const [id, assignmentId, slot] of [
      [BOOKING_ASSIGNED, assignment, 0],
      [BOOKING_UNASSIGNED, null, 1],
    ] as const)
      await db.query(
        `INSERT INTO pms.channel_booking_mappings (id, property_id, connection_id, guest_booking_id, assignment_id, external_booking_id, channel_room_index, sync_status)
         VALUES ($1, $2, $3, $4, $5, 'x-booking', $6, 'ignored')`,
        [id, PROPERTY, connectionId, GUEST_BOOKING, assignmentId, slot],
      );
  }

  async function cleanup() {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const properties = [PROPERTY, OTHER];
      for (const table of ["platform.product_audit_events", "platform.jobs"])
        await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          properties,
        ]);
      await client.query(
        `DELETE FROM pms.channex_external_rate_owners WHERE connection_id IN
           (SELECT id FROM pms.channel_connections WHERE property_id = ANY($1::uuid[]))`,
        [properties],
      );
      for (const table of [
        "pms.channel_booking_mappings",
        "pms.channel_rate_plan_mappings",
        "pms.channel_room_type_mappings",
        "pms.operational_booking_assignments",
        "booking.nightly_revenue_room_scopes",
        "booking.guest_bookings",
        "pms.channel_connections",
        "pms.channel_binding_claims",
        "pms.rate_plans",
        "pms.room_types",
        "hotel_catalog.property_source_links",
      ])
        await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          properties,
        ]);
      await client.query("DELETE FROM pms.channel_binding_claims WHERE external_property_id = $1", [
        EXTERNAL,
      ]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        properties,
      ]);
      const cohorts = await client.query(
        "SELECT to_regclass('platform.production_migration_cohorts') AS t",
      );
      if (cohorts.rows[0].t)
        await client.query(
          "DELETE FROM platform.production_migration_cohorts WHERE source_run_id = $1",
          [RUN],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
