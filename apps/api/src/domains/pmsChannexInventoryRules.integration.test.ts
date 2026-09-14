import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@vayada/backend-auth";
import { createPgPmsChannexManagementCommandPort } from "./pmsChannexManagementCommandStore.js";
import { createPgPmsChannexManagementReadRepository } from "./pmsChannexManagementReadModel.js";
import { createPgChannexManagementPlanPort } from "../integrations/channexManagementPlans.js";
import { createChannexManagementProvider } from "../integrations/channexManagement.js";
import { createPgPmsChannexManagementWorkerStore } from "../jobs/pmsChannexManagementWorkerStore.js";
import { createPmsChannexManagementTargetState } from "../jobs/pmsChannexManagementTargetState.js";
import { runPmsChannexManagementWorkerOnce } from "../jobs/pmsChannexManagementWorker.js";
import type { ChannexInventoryRule } from "@vayada/domain-pms-channex";
import { verifyChannexRoomClosure } from "../integrations/channexRoomClosure.js";

const connectionString = process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("inventory rules durable Postgres path (mock Channex)", () => {
  const db = new pg.Pool({ connectionString });
  const commands = createPgPmsChannexManagementCommandPort({
    connectionString: connectionString ?? "disabled",
  });
  const reads = createPgPmsChannexManagementReadRepository({
    connectionString: connectionString ?? "disabled",
  });
  const plans = createPgChannexManagementPlanPort({
    connectionString: connectionString ?? "disabled",
    bookingRevisionHandoff: async () => {},
  });
  const propertyId = randomUUID(),
    roomId = randomUUID(),
    channelId = randomUUID(),
    actorId = randomUUID(),
    externalPropertyId = randomUUID();
  const store = createPgPmsChannexManagementWorkerStore({
    connectionString: connectionString ?? "disabled",
    targetState: createPmsChannexManagementTargetState(),
    stagingRestrictionsPropertyId: propertyId,
    stagingInventoryEnabled: true,
  });
  const context = {
    actor: { internalUserId: actorId },
    audit: { requestId: "vay1531-test", source: "api" },
  } as RequestContext;
  let remote: Array<{ id: string; attributes: Record<string, unknown> }> = [];
  const provider = createChannexManagementProvider({
    apiBaseUrl: "https://staging.channex.io",
    apiKey: "synthetic-test-key",
    plans,
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/channels")
        return Response.json({
          data: [
            {
              id: channelId,
              attributes: {
                properties: [externalPropertyId],
                channel: "BookingCom",
                is_active: true,
              },
            },
          ],
          meta: { total: 1 },
        });
      if (options?.method === "GET")
        return Response.json({ data: remote, meta: { total: remote.length } });
      if (options?.method === "DELETE") {
        remote = remote.filter((item) => item.id !== path.split("/").at(-1));
        return Response.json({});
      }
      const attributes = JSON.parse(String(options?.body)).channel_availability_rule;
      const id = options?.method === "PUT" ? path.split("/").at(-1)! : randomUUID();
      remote = [...remote.filter((item) => item.id !== id), { id, attributes }];
      return Response.json({ data: { id } });
    },
  });
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("test"))
      throw new Error("Disposable local test database required");
    await db.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
      actorId,
      `${actorId}@example.test`,
    ]);
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'VAY-1531 synthetic')",
      [propertyId, propertyId],
    );
    await db.query(
      "INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Synthetic room')",
      [roomId, propertyId],
    );
    await db.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
      VALUES($1,'channex',$2,'active','enable')`,
      [propertyId, externalPropertyId],
    );
    const result = await db.query(
      `INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id,connection_metadata)
      VALUES($1,'channex','connected',$2,$3) RETURNING id`,
      [
        propertyId,
        externalPropertyId,
        JSON.stringify({
          connectedChannels: [
            {
              externalChannelId: channelId,
              key: "booking_com",
              application: "BookingCom",
              title: null,
              isActive: true,
            },
          ],
        }),
      ],
    );
    await db.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id,status)
      VALUES($1::uuid,$2::uuid,$3::uuid,$3::text,'active')`,
      [propertyId, result.rows[0].id, roomId],
    );
  });
  afterAll(async () => {
    await Promise.all([
      db.end(),
      commands.close?.(),
      reads.close?.(),
      plans.close(),
      store.close?.(),
    ]);
  });
  it("holds the provider lock through closure readback and rejects an in-flight owner", async () => {
    const client = await db.connect(),
      contender = await db.connect(),
      rate = randomUUID();
    const config = {
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic-test-key",
      workerEnabled: false,
      stagingRestrictionsPropertyId: propertyId,
      bookingMutationOwner: "target" as const,
      capabilityModes: {
        connection: "observe_only",
        provisioning: "observe_only",
        ariSync: "observe_only",
        bookingSync: "observe_only",
        markups: "observe_only",
        messaging: "observe_only",
        reviews: "observe_only",
        iframe: "observe_only",
      } as const,
    };
    const scope = { propertyId, roomTypeId: roomId, from: "2026-09-09", through: "2026-09-09" };
    const fetcher: typeof fetch = async (url) => {
      if (String(url).includes("/rate_plans?"))
        return Response.json({
          data: [
            {
              id: rate,
              relationships: {
                property: { data: { id: externalPropertyId } },
                room_type: { data: { id: roomId } },
              },
            },
          ],
          meta: { total: 1 },
        });
      if (String(url).includes("/channels?"))
        return Response.json({ data: [], meta: { total: 0 } });
      return Response.json({
        data: String(url).includes("/availability?")
          ? { [roomId]: { [scope.from]: 0 } }
          : { [rate]: { [scope.from]: { stop_sell: true } } },
      });
    };
    try {
      await client.query("BEGIN");
      await contender.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        `channex.management:${propertyId}`,
      ]);
      await expect(verifyChannexRoomClosure(client, config, scope, fetcher)).rejects.toThrow(
        "operation_in_flight",
      );
      await contender.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `channex.management:${propertyId}`,
      ]);
      await client.query(
        `INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,name,base_rate_amount,currency)
        VALUES ($1,$2,$3,'closure','Closure',100,'EUR')`,
        [rate, propertyId, roomId],
      );
      await client.query(
        `INSERT INTO pms.channel_rate_plan_mappings
        (property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id,status)
        SELECT $1::uuid,id,$2::uuid,$3::uuid,'direct',$2::text,$3::text,'active'
        FROM pms.channel_connections WHERE property_id=$1::uuid`,
        [propertyId, roomId, rate],
      );
      await verifyChannexRoomClosure(client, config, scope, fetcher);
      expect(
        (
          await contender.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [
            `channex.management:${propertyId}`,
          ])
        ).rows[0].locked,
      ).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      await contender.query("SELECT pg_advisory_unlock_all()");
      client.release();
      contender.release();
    }
  });
  it("commits state and jobs together, replays once, prevents lost edits, and retries latest desired removal", async () => {
    const rule: ChannexInventoryRule = {
      id: randomUUID(),
      type: "availability_offset",
      value: 2,
      channelIds: [channelId],
      roomTypeIds: [roomId],
      startDate: "2026-10-01",
      endDate: "2026-10-07",
      days: ["mo"],
    };
    const input = {
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      operationType: "update_inventory_rules" as const,
      inventoryRules: { expectedOperationId: null as string | null, rules: [rule] },
    };
    const first = await commands.enqueue(context, propertyId, input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await commands.enqueue(context, propertyId, input)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(
      await commands.enqueue(context, propertyId, { ...input, idempotencyKey: randomUUID() }),
    ).toMatchObject({ ok: false, code: "invalid_inventory_rules" });
    expect(
      await runPmsChannexManagementWorkerOnce({ store, provider, workerId: "vay1531" }),
    ).toMatchObject({ outcome: "succeeded" });
    expect(remote).toHaveLength(1);
    const modes = {
      connection: "mutating",
      provisioning: "mutating",
      ariSync: "mutating",
      bookingSync: "mutating",
      markups: "mutating",
      messaging: "mutating",
      iframe: "mutating",
    } as const;
    expect((await reads.getSnapshot(propertyId, modes)).inventoryRules).toMatchObject({
      rules: [rule],
      operation: { status: "succeeded" },
    });
    const edit = await commands.enqueue(context, propertyId, {
      ...input,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      inventoryRules: {
        expectedOperationId: first.operation.operationId,
        rules: [{ ...rule, type: "max_availability", value: 3 }],
      },
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const removal = await commands.enqueue(context, propertyId, {
      ...input,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      inventoryRules: { expectedOperationId: edit.operation.operationId, rules: [] },
    });
    expect(removal.ok).toBe(true);
    // The older queued edit must reload the latest desired state rather than restore its cap.
    expect(
      await runPmsChannexManagementWorkerOnce({ store, provider, workerId: "vay1531" }),
    ).toMatchObject({ outcome: "succeeded" });
    expect(remote).toEqual([]);
    expect((await reads.getSnapshot(propertyId, modes)).inventoryRules?.operation?.status).toBe(
      "queued",
    );
    expect(
      await runPmsChannexManagementWorkerOnce({ store, provider, workerId: "vay1531" }),
    ).toMatchObject({ outcome: "succeeded" });
    expect((await reads.getSnapshot(propertyId, modes)).inventoryRules).toMatchObject({
      rules: [],
      operation: { status: "succeeded" },
    });
  });
});
