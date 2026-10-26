import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PmsRoomOrderCommand } from "../routes/pmsOperations.js";
import { createTargetPmsOperationsCommandRepository } from "./pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { pmsRoomOrderVersion } from "./pmsRoomOrder.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("PMS room order PostgreSQL (VAY-2294)", () => {
  const db = new pg.Client({ connectionString: url });
  const commands = createTargetPmsOperationsCommandRepository({
    connectionString: url ?? "postgresql://integration-test-disabled",
    readRepository: createTargetPmsOperationsReadRepository({
      connectionString: url ?? "postgresql://integration-test-disabled",
    }),
  });
  const reads = createTargetPmsOperationsReadRepository({
    connectionString: url ?? "postgresql://integration-test-disabled",
  });
  let propertyId: string;
  let actorId: string;

  beforeAll(async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname))
      throw new Error("Test database required");
    await db.connect();
  });
  afterAll(async () => {
    await commands.close?.();
    await reads.close?.();
    await db.end();
  });
  beforeEach(async () => {
    propertyId = randomUUID();
    actorId = randomUUID();
    await db.query(
      "INSERT INTO identity.users (id,email,name,status) VALUES ($1,$2,'Room order test','active')",
      [actorId, `${actorId}@example.test`],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1::uuid,$1::text,'Room order test')",
      [propertyId],
    );
  });

  async function roomType(name: string, sortOrder: number): Promise<string> {
    const id = randomUUID();
    await db.query(
      "INSERT INTO pms.room_types (id,property_id,name,active,sort_order) VALUES ($1,$2,$3,true,$4)",
      [id, propertyId, name, sortOrder],
    );
    return id;
  }

  async function room(roomTypeId: string, roomNumber: string, sortOrder: number): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO pms.rooms (
         id, property_id, room_type_id, room_number, status, operational_label_status, sort_order
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'available', 'verified', $5)`,
      [id, propertyId, roomTypeId, roomNumber, sortOrder],
    );
    return id;
  }

  function reorder(orderedRoomIds: string[], expectedVersion: string): PmsRoomOrderCommand {
    const commandId = `room-order-${randomUUID()}`;
    return {
      propertyId,
      commandId,
      idempotencyKey: commandId,
      expectedVersion,
      orderedRoomIds,
      audit: {
        actor: { kind: "user", userId: actorId, organizationId: randomUUID() },
        requestId: commandId,
        reason: "Reorder rooms",
        requestedAt: "2026-10-22T10:00:00.000Z",
      },
    };
  }

  it("moves room types to their first room's slot, keeps a room type without rooms in place and leaves room type updated_at alone", async () => {
    const alpha = await roomType("Alpha", 1);
    await roomType("Empty", 2);
    const bravo = await roomType("Bravo", 3);
    const charlie = await roomType("Charlie", 4);
    const a1 = await room(alpha, "A1", 1);
    const a2 = await room(alpha, "A2", 2);
    const b1 = await room(bravo, "B1", 3);
    const c1 = await room(charlie, "C1", 4);
    const before = await db.query<{ updatedAt: Date }>(
      'SELECT updated_at AS "updatedAt" FROM pms.room_types WHERE property_id=$1 ORDER BY id',
      [propertyId],
    );

    await expect(
      commands.reorderRooms!(reorder([c1, a1, a2, b1], pmsRoomOrderVersion([a1, a2, b1, c1]))),
    ).resolves.toMatchObject({ ok: true, orderedRoomIds: [c1, a1, a2, b1] });

    const types = await reads.listRoomTypesByPropertyId(propertyId);
    expect(types.items.map(({ name }) => name)).toEqual(["Charlie", "Empty", "Alpha", "Bravo"]);
    const rooms = await reads.listRoomsByPropertyId(propertyId);
    expect(rooms.items.map(({ roomNumber }) => roomNumber)).toEqual(["C1", "A1", "A2", "B1"]);
    await expect(
      db.query(
        'SELECT updated_at AS "updatedAt" FROM pms.room_types WHERE property_id=$1 ORDER BY id',
        [propertyId],
      ),
    ).resolves.toMatchObject({ rows: before.rows });
    const audit = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT redacted_payload AS payload FROM platform.product_audit_events
       WHERE property_id=$1::uuid AND action='pms.rooms.reordered'`,
      [propertyId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.payload["orderedRoomTypeIds"]).toHaveLength(4);
  });

  it("keeps the room type order when only rooms inside a type move", async () => {
    const alpha = await roomType("Alpha", 0);
    const bravo = await roomType("Bravo", 0);
    const a1 = await room(alpha, "A1", 1);
    const a2 = await room(alpha, "A2", 2);
    const b1 = await room(bravo, "B1", 3);

    await expect(
      commands.reorderRooms!(reorder([a2, a1, b1], pmsRoomOrderVersion([a1, a2, b1]))),
    ).resolves.toMatchObject({ ok: true });

    const types = await reads.listRoomTypesByPropertyId(propertyId);
    expect(types.items.map(({ name }) => name)).toEqual(["Alpha", "Bravo"]);
    const rooms = await reads.listRoomsByPropertyId(propertyId);
    expect(rooms.items.map(({ roomNumber }) => roomNumber)).toEqual(["A2", "A1", "B1"]);
  });

  it("waits for a room type that retire holds instead of deadlocking on the rooms table", async () => {
    const alpha = await roomType("Alpha", 1);
    const bravo = await roomType("Bravo", 2);
    const a1 = await room(alpha, "A1", 1);
    const b1 = await room(bravo, "B1", 2);
    const retire = new pg.Client({ connectionString: url });
    await retire.connect();
    try {
      // Room type retire locks its room type row, then the rooms table.
      await retire.query("BEGIN");
      await retire.query("SELECT id FROM pms.room_types WHERE id=$1 FOR UPDATE", [bravo]);
      const saving = commands.reorderRooms!(reorder([b1, a1], pmsRoomOrderVersion([a1, b1])));
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const blocked = await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query LIKE '%FROM pms.room_types WHERE property_id%FOR UPDATE%'`,
        );
        waiting = blocked.rows[0]!.count > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await retire.query("SET LOCAL lock_timeout = '2s'");
      await retire.query("LOCK TABLE pms.rooms IN SHARE ROW EXCLUSIVE MODE");
      await retire.query("COMMIT");
      await expect(saving).resolves.toMatchObject({ ok: true });
    } finally {
      await retire.query("ROLLBACK").catch(() => undefined);
      await retire.end();
    }
    const types = await reads.listRoomTypesByPropertyId(propertyId);
    expect(types.items.map(({ name }) => name)).toEqual(["Bravo", "Alpha"]);
  });
});
