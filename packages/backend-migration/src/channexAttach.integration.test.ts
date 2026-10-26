import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyChannexHandover,
  planChannexAttach,
  planChannexHandover,
  type ChannexHandoverInput,
} from "./channexHandover.js";

const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

// VAY-2108: a fresh target property (normal onboarding) attached to the Channex property the old
// system ran, then revoked and attached again.
const PROPERTY = "21082000-0000-4000-8000-000000000001";
const OTHER = "21082000-0000-4000-8000-000000000002";
const EXTERNAL = "21082000-0000-4000-8000-0000000000ee";
const [ROOM_A, ROOM_B, ROOM_OFF] = ["a1", "a2", "a3"].map(
  (n) => `21082000-0000-4000-8000-0000000000${n}`,
);
const [X_ROOM_A, X_ROOM_B] = ["b1", "b2"].map((n) => `21082000-0000-4000-8000-0000000000${n}`);
// Rate codes take the external id's first eight characters, so the prefixes differ.
const [X_RATE_A, X_RATE_B1, X_RATE_B2] = ["2108c001", "2108c002", "2108c003"].map(
  (n) => `${n}-0000-4000-8000-000000000000`,
);
const rate = (externalRatePlanId: string, name: string) => ({
  externalRatePlanId,
  name,
  sellMode: "per_room",
  currency: "EUR",
  rateType: "flexible",
});
const manifest = {
  capabilities: ["booking", "ari"],
  roomTypes: [
    { roomTypeId: ROOM_A, externalRoomTypeId: X_ROOM_A, ratePlans: [rate(X_RATE_A, "Standard")] },
    {
      roomTypeId: ROOM_B,
      externalRoomTypeId: X_ROOM_B,
      ratePlans: [
        rate(X_RATE_B1, "Flexible"),
        { ...rate(X_RATE_B2, "Non-refundable"), rateType: "non_refundable" },
      ],
    },
  ],
  unmappedRoomTypeIds: [],
};
const attach: ChannexHandoverInput = {
  command: "attach",
  propertyId: PROPERTY,
  externalPropertyId: EXTERNAL,
  approvalRef: "VAY-2108 attach test",
  legacyDisabledAt: "2026-10-26T08:00:00.000Z",
  legacyReadbackSha256: "a".repeat(64),
  manifest,
  manifestSha256: "1".repeat(64),
};
const revoke: ChannexHandoverInput = {
  command: "revoke",
  propertyId: PROPERTY,
  approvalRef: "VAY-2108 attach test",
  reason: "Rehearsed rollback",
};

describe.skipIf(!URL)("Channex attach executor (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 2 });

  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("refuses a bad manifest, an unmapped or foreign room type, and a taken Channex id", async () => {
    const withManifest = (value: unknown): ChannexHandoverInput => ({ ...attach, manifest: value });
    for (const [code, input] of [
      ["manifest_invalid", withManifest({ ...manifest, extra: true })],
      ["manifest_invalid", withManifest({ ...manifest, roomTypes: [] })],
      [
        "manifest_invalid",
        withManifest({
          ...manifest,
          roomTypes: [{ ...manifest.roomTypes[0], ratePlans: [] }, manifest.roomTypes[1]],
        }),
      ],
      [
        "manifest_invalid",
        withManifest({
          ...manifest,
          roomTypes: [
            manifest.roomTypes[0],
            { ...manifest.roomTypes[1], externalRoomTypeId: X_ROOM_A },
          ],
        }),
      ],
      ["capabilities_invalid", withManifest({ ...manifest, capabilities: ["booking"] })],
      ["room_type_unmapped", withManifest({ ...manifest, roomTypes: [manifest.roomTypes[0]] })],
      ["room_type_unknown", withManifest({ ...manifest, unmappedRoomTypeIds: [ROOM_OFF] })],
      [
        "room_type_unknown",
        withManifest({
          ...manifest,
          roomTypes: [
            ...manifest.roomTypes,
            {
              roomTypeId: ROOM_OFF,
              externalRoomTypeId: X_RATE_A,
              ratePlans: [rate("2108c009-0000-4000-8000-000000000000", "Off")],
            },
          ],
        }),
      ],
      [
        "currency_mismatch",
        withManifest({
          ...manifest,
          roomTypes: [
            manifest.roomTypes[0],
            {
              ...manifest.roomTypes[1],
              ratePlans: [{ ...rate(X_RATE_B1, "Swiss"), currency: "CHF" }],
            },
          ],
        }),
      ],
      [
        "reserved_identity",
        { ...attach, externalPropertyId: "8f4c1e47-3de1-4150-8bde-ad031a013842" },
      ],
      ["external_id_invalid", { ...attach, externalPropertyId: "not-a-uuid" }],
      ["legacy_disabled_at_invalid", { ...attach, legacyDisabledAt: "2026-10-26 08:00" }],
      ["manifest_invalid", { ...attach, manifestSha256: "short" }],
    ] as const) {
      await expect(plan(input), code).rejects.toThrow(code);
    }
    const refusals: Array<[string, string, unknown[]]> = [
      [
        "claim_conflict",
        `INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source) VALUES ($1, 'channex', $2, 'released', 'enable')`,
        [OTHER, EXTERNAL],
      ],
      [
        "claim_conflict",
        `INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source) VALUES ($1, 'channex', $2, 'active', 'enable');
         INSERT INTO pms.channel_connections (property_id, provider, connection_status, external_property_id) VALUES ($1, 'channex', 'connected', $2)`,
        [OTHER, EXTERNAL],
      ],
      [
        "claim_exists",
        `INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source) VALUES ($1, 'channex', 'other-external', 'historical', 'migration')`,
        [PROPERTY],
      ],
      [
        "connection_already_bound",
        `INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source) VALUES ($1, 'channex', 'other-external', 'active', 'enable');
         INSERT INTO pms.channel_connections (property_id, provider, connection_status, external_property_id) VALUES ($1, 'channex', 'connected', 'other-external')`,
        [PROPERTY],
      ],
      [
        "use_activate",
        `INSERT INTO pms.channel_connections (property_id, provider, connection_status, connection_metadata) VALUES ($1, 'channex', 'disconnected', '{"channexHandover":"pending","legacyExternalPropertyId":"x"}')`,
        [PROPERTY],
      ],
      [
        "management_job_running",
        `INSERT INTO platform.jobs (job_key, queue_name, job_type, status, attempts_count, locked_at, locked_by, tenant_scope, property_id) VALUES ('vay-2108-attach-running', 'pms.channex.management', 'channex.sync_ari', 'running', 1, now(), 'fixture', 'property', $1)`,
        [PROPERTY],
      ],
    ];
    for (const [code, sql, values] of refusals) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const statement of sql.split(";")) await client.query(statement, values);
        await expect(planChannexAttach(client, attach), code).rejects.toThrow(code);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    await expect(applyChannexHandover(db, attach, "0".repeat(64))).rejects.toThrow("plan_changed");
    expect(await claims()).toEqual([]);
    expect(await connection()).toBeNull();
  });

  it("writes nothing when any step fails", async () => {
    const { planSha256 } = await plan(attach);
    await db.query(`CREATE FUNCTION pms.vay2108_attach_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'vay2108 forced failure'; END $$`);
    await db.query(`CREATE TRIGGER vay2108_attach_fail BEFORE INSERT ON pms.channel_rate_plan_mappings
      FOR EACH ROW EXECUTE FUNCTION pms.vay2108_attach_fail()`);
    try {
      await expect(applyChannexHandover(db, attach, planSha256)).rejects.toThrow(
        "vay2108 forced failure",
      );
    } finally {
      await db.query("DROP TRIGGER vay2108_attach_fail ON pms.channel_rate_plan_mappings");
      await db.query("DROP FUNCTION pms.vay2108_attach_fail()");
    }
    expect(await claims()).toEqual([]);
    expect(await connection()).toBeNull();
    expect(
      (await db.query("SELECT 1 FROM pms.rate_plans WHERE property_id = $1", [PROPERTY])).rowCount,
    ).toBe(0);
  });

  it("attaches the claim, the connection, the mappings and the adopted rate plans, once per plan", async () => {
    const sealed = await plan(attach);
    expect(sealed.plan).toMatchObject({
      connectionId: null,
      claimId: null,
      externalPropertyId: EXTERNAL,
      capabilities: ["booking", "ari"],
      evidence: { manifestSha256: "1".repeat(64), externalPropertyId: EXTERNAL },
    });
    const shape = (rooms: typeof sealed.plan.roomTypes) =>
      rooms.map((room) => [
        room.mappingId === null,
        room.ratePlans.map((r) => [r.code, r.ratePlanId === null, r.mappingId === null]),
      ]);
    expect(shape(sealed.plan.roomTypes)).toEqual([
      [true, [["CH-2108c001", true, true]]],
      [
        true,
        [
          ["CH-2108c002", true, true],
          ["CH-2108c003", true, true],
        ],
      ],
    ]);
    // The Channex id is lowercased everywhere: a mixed-case input yields the same plan.
    expect((await plan({ ...attach, externalPropertyId: EXTERNAL.toUpperCase() })).planSha256).toBe(
      sealed.planSha256,
    );
    const result = await applyChannexHandover(db, attach, sealed.planSha256);
    expect(result).toMatchObject({ replayed: false, planSha256: sealed.planSha256 });
    expect(await claims()).toEqual([{ state: "active", source: "handover", external: EXTERNAL }]);
    const live = await connection();
    expect(live).toMatchObject({
      status: "connected",
      external: EXTERNAL,
      capabilities: ["booking", "ari"],
      messaging: false,
    });
    expect(live!.metadata).toEqual({
      channexHandover: "completed",
      channexAttach: {
        approvalRef: attach.approvalRef,
        legacyDisabledAt: "2026-10-26T08:00:00.000Z",
        legacyReadbackSha256: "a".repeat(64),
        manifestSha256: "1".repeat(64),
      },
    });
    expect(await mappings()).toEqual({
      rooms: [
        [ROOM_A, X_ROOM_A, "active"],
        [ROOM_B, X_ROOM_B, "active"],
      ],
      rates: [
        [ROOM_A, "CH-2108c001", "Standard", "flexible", X_ROOM_A, X_RATE_A, "per_room", "active"],
        [ROOM_B, "CH-2108c002", "Flexible", "flexible", X_ROOM_B, X_RATE_B1, "per_room", "active"],
        [
          ROOM_B,
          "CH-2108c003",
          "Non-refundable",
          "non_refundable",
          X_ROOM_B,
          X_RATE_B2,
          "per_room",
          "active",
        ],
      ],
      owners: [
        [X_RATE_A, "legacy"],
        [X_RATE_B1, "legacy"],
        [X_RATE_B2, "legacy"],
      ],
    });
    // The upcoming-bookings copy is queued for the claimed booking worker, bound to this binding.
    expect(await resyncJobs()).toEqual([
      { status: "pending", providerPropertyId: EXTERNAL, bindingGeneration: live!.generation },
    ]);
    const audit = await db.query(
      `SELECT action, actor_type, target_resource_id AS target, redacted_payload->>'connectionId' AS connection,
         redacted_payload->'evidence'->>'manifestSha256' AS manifest
       FROM platform.product_audit_events WHERE id = $1::uuid`,
      [result.auditId],
    );
    expect(audit.rows[0]).toEqual({
      action: "pms.channex.handover.attached",
      actor_type: "migration",
      target: PROPERTY,
      connection: live!.id,
      manifest: "1".repeat(64),
    });
    // The applied plan replays; a different manifest or a fresh plan does not.
    expect(await applyChannexHandover(db, attach, sealed.planSha256)).toMatchObject({
      replayed: true,
      auditId: result.auditId,
    });
    await expect(
      applyChannexHandover(db, { ...attach, manifestSha256: "2".repeat(64) }, sealed.planSha256),
    ).rejects.toThrow("replay_mismatch");
    await expect(plan(attach)).rejects.toThrow("connection_already_bound");
    await expect(
      applyChannexHandover(db, { ...attach, approvalRef: "VAY-2108 other ref" }, sealed.planSha256),
    ).rejects.toThrow("replay_mismatch");
  });

  it("revokes like a handover, and a second attach reuses the retained rows", async () => {
    const revoked = await planHandover(revoke);
    await applyChannexHandover(db, revoke, revoked.planSha256);
    expect(await claims()).toEqual([{ state: "released", source: "handover", external: EXTERNAL }]);
    expect((await connection())!.status).toBe("disconnected");
    expect((await mappings()).rooms.map((row) => row[2])).toEqual(["disabled", "disabled"]);
    const first = await db.query<{ id: string }>(
      "SELECT id::text FROM pms.rate_plans WHERE property_id = $1 ORDER BY code",
      [PROPERTY],
    );
    // The attach plan applied before the revoke is superseded by it.
    const firstSha = (
      await db.query<{ sha: string }>(
        `SELECT redacted_payload->>'planSha256' AS sha FROM platform.product_audit_events
         WHERE property_id = $1 AND action = 'pms.channex.handover.attached' ORDER BY occurred_at LIMIT 1`,
        [PROPERTY],
      )
    ).rows[0]!.sha;
    await expect(applyChannexHandover(db, attach, firstSha)).rejects.toThrow("plan_superseded");
    // A retained CH- rate plan with another rate type, or a Channex rate plan an offer target
    // owns, cannot be adopted.
    await expect(
      plan({
        ...attach,
        manifest: {
          ...manifest,
          roomTypes: [
            {
              ...manifest.roomTypes[0]!,
              ratePlans: [{ ...rate(X_RATE_A, "Standard"), rateType: "non_refundable" }],
            },
            manifest.roomTypes[1]!,
          ],
        },
      }),
    ).rejects.toThrow("mapping_conflict");
    const X_RATE_OFFER = "2108c004-0000-4000-8000-000000000000";
    await db.query(
      "INSERT INTO pms.channex_external_rate_owners VALUES ($1, $2, 'offer', gen_random_uuid(), NULL)",
      [(await connection())!.id, X_RATE_OFFER],
    );
    await expect(
      plan({
        ...attach,
        manifest: {
          ...manifest,
          roomTypes: [
            {
              ...manifest.roomTypes[0]!,
              ratePlans: [rate(X_RATE_A, "Standard"), rate(X_RATE_OFFER, "Offer")],
            },
            manifest.roomTypes[1]!,
          ],
        },
      }),
    ).rejects.toThrow("rate_owned");
    const again = await plan(attach);
    expect(again.plan.claimId).toEqual(expect.any(String));
    expect(again.plan.connectionId).toEqual(expect.any(String));
    expect(again.plan.roomTypes.every((room) => room.mappingId !== null)).toBe(true);
    expect(again.plan.roomTypes.flatMap((room) => room.ratePlans.map((r) => r.ratePlanId))).toEqual(
      first.rows.map((row) => row.id),
    );
    // A manifest that moves a Channex room to another room type cannot reuse the old rows.
    await expect(
      plan({
        ...attach,
        manifest: {
          ...manifest,
          roomTypes: [
            { ...manifest.roomTypes[0]!, externalRoomTypeId: X_ROOM_B },
            { ...manifest.roomTypes[1]!, externalRoomTypeId: X_ROOM_A },
          ],
        },
      }),
    ).rejects.toThrow("mapping_conflict");
    await applyChannexHandover(db, attach, again.planSha256);
    expect(await claims()).toEqual([{ state: "active", source: "handover", external: EXTERNAL }]);
    const live = await connection();
    expect(live!.status).toBe("connected");
    expect((await mappings()).rooms.map((row) => row[2])).toEqual(["active", "active"]);
    expect((await mappings()).rates.map((row) => row[7])).toEqual(["active", "active", "active"]);
    expect(
      (
        await db.query("SELECT count(*)::int AS n FROM pms.rate_plans WHERE property_id = $1", [
          PROPERTY,
        ])
      ).rows[0].n,
    ).toBe(3);
    expect((await resyncJobs()).map((job) => job.bindingGeneration)).toContain(live!.generation);
    expect((await resyncJobs()).length).toBe(2);
  });

  async function plan(input: ChannexHandoverInput) {
    if (input.command !== "attach") throw new Error("attach input expected");
    const client = await db.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      return await planChannexAttach(client, input);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  async function planHandover(input: ChannexHandoverInput) {
    if (input.command !== "revoke") throw new Error("revoke input expected");
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
        "SELECT claim_state AS state, claim_source AS source, external_property_id AS external FROM pms.channel_binding_claims WHERE property_id = $1",
        [PROPERTY],
      )
    ).rows;
  }
  async function connection() {
    return (
      (
        await db.query<{
          id: string;
          status: string;
          external: string | null;
          capabilities: string[];
          messaging: boolean;
          metadata: Record<string, unknown>;
          generation: string;
        }>(
          `SELECT id::text, connection_status AS status, external_property_id AS external, capabilities,
             messaging_app_installed AS messaging, connection_metadata AS metadata, binding_generation::text AS generation
           FROM pms.channel_connections WHERE property_id = $1 AND provider = 'channex'`,
          [PROPERTY],
        )
      ).rows[0] ?? null
    );
  }
  async function mappings() {
    const rooms = await db.query(
      `SELECT room_type_id::text AS room, external_room_type_id AS external, status
       FROM pms.channel_room_type_mappings WHERE property_id = $1 ORDER BY room_type_id`,
      [PROPERTY],
    );
    const rates = await db.query(
      `SELECT m.room_type_id::text AS room, rate.code, rate.name, rate.rate_type AS type, m.external_room_type_id AS "externalRoom",
         m.external_rate_plan_id AS external, m.sell_mode AS mode, m.status
       FROM pms.channel_rate_plan_mappings m JOIN pms.rate_plans rate ON rate.id = m.rate_plan_id
       WHERE m.property_id = $1 ORDER BY rate.code`,
      [PROPERTY],
    );
    const owners = await db.query(
      `SELECT owner.external_rate_plan_id AS external, owner.owner_kind AS kind
       FROM pms.channex_external_rate_owners owner JOIN pms.channel_connections c ON c.id = owner.connection_id
       WHERE c.property_id = $1 ORDER BY 1`,
      [PROPERTY],
    );
    return {
      rooms: rooms.rows.map((row) => [row.room, row.external, row.status]),
      rates: rates.rows.map((row) => [
        row.room,
        row.code,
        row.name,
        row.type,
        row.externalRoom,
        row.external,
        row.mode,
        row.status,
      ]),
      owners: owners.rows.map((row) => [row.external, row.kind]),
    };
  }
  async function resyncJobs() {
    return (
      await db.query<{ status: string; providerPropertyId: string; bindingGeneration: string }>(
        `SELECT status, payload->>'providerPropertyId' AS "providerPropertyId", payload->>'bindingGeneration' AS "bindingGeneration"
         FROM platform.jobs WHERE queue_name = 'pms.channex.webhooks' AND job_type = 'channex.resync-bookings'
           AND property_id = $1 ORDER BY created_at`,
        [PROPERTY],
      )
    ).rows;
  }

  async function seed() {
    for (const [id, slug] of [
      [PROPERTY, "vay-2108-attach"],
      [OTHER, "vay-2108-attach-other"],
    ] as const)
      await db.query(
        "INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, $2, 'VAY-2108 attach')",
        [id, slug],
      );
    for (const room of [ROOM_A, ROOM_B, ROOM_OFF])
      await db.query(
        "INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency, active) VALUES ($1, $2, $4, 0, 'EUR', $3)",
        [room, PROPERTY, room !== ROOM_OFF, `room ${room.slice(-2)}`],
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
        "pms.channel_rate_plan_mappings",
        "pms.channel_room_type_mappings",
        "pms.channel_connections",
        "pms.channel_binding_claims",
        "pms.rate_plans",
        "pms.room_types",
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
