import { createHash } from "node:crypto";
import pg from "pg";
import type { ChannexManagementConfig } from "../config.js";
import { verifyChannexRoomClosure } from "../integrations/channexRoomClosure.js";
import { suppressClosingRoomOffers } from "./distributionRoomClosure.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsManageScope } from "./pmsManageScope.js";
import {
  readPmsRoomClosureState,
  type PmsRoomClosureScope,
  type PmsRoomClosureState,
} from "./pmsRoomClosureState.js";
import { closeRoomClosureInventory, appendRoomClosureCalendar } from "./pmsRoomClosureCalendar.js";
import { retireClosingRoomUnits } from "./pmsRoomClosureUnits.js";
import { recordPmsRoomClosureEvents } from "./pmsRoomClosureEvents.js";

export type PmsRoomClosureCommand = PmsRoomClosureScope & {
  expectedRoomFactsRevision: number;
  expectedRoomUnitsRevision: number;
  expectedCalendarRevision: number;
  expectedActivePublicationRevisionId: string | null;
  idempotencyKey: string;
  requestId: string;
  correlationId?: string;
};
type Failure = { ok: false; error: { code: string; blockers?: string[] } };
export type PmsRoomClosureSuccess = {
  ok: true;
  commandId: string;
  propertyId: string;
  roomTypeId: string;
  calendarRevision: number;
  roomUnitsRevision: number;
  cutoffDate: string;
  retiredUnitIds: string[];
  closedInventoryDays: number;
  suppressedOfferDays: number;
  phase: "publication_refresh_required";
};
export type PmsRoomClosureResult = PmsRoomClosureSuccess | Failure;
export type PmsRoomClosureRepository = ReturnType<typeof createPgPmsRoomClosureRepository>;
class ClosureRejected extends Error {
  constructor(
    readonly code: string,
    readonly blockers?: string[],
  ) {
    super(code);
  }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createPgPmsRoomClosureRepository(config: {
  connectionString: string;
  channex: ChannexManagementConfig;
  now?: () => Date;
  fetch?: typeof fetch;
}) {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 4 });
  const now = config.now ?? (() => new Date());
  return {
    dispose: () => pool.end(),
    preview: (scope: PmsRoomClosureScope) =>
      transaction<{ ok: true; impact: PmsRoomClosureState }>(scope, async (client, at) => {
        await lockScope(client, scope.propertyId);
        const impact = await readPmsRoomClosureState(client, scope, at);
        if (!impact) throw new ClosureRejected("room_type_not_found");
        return { ok: true, impact };
      }),
    closeRoom: (command: PmsRoomClosureCommand) =>
      transaction<PmsRoomClosureSuccess>(command, async (client, at) => {
        const keyHash = hash(command.idempotencyKey);
        const fingerprint = hash(
          JSON.stringify([
            command.organizationId,
            command.propertyId,
            command.roomTypeId,
            command.expectedRoomFactsRevision,
            command.expectedRoomUnitsRevision,
            command.expectedCalendarRevision,
            command.expectedActivePublicationRevisionId,
          ]),
        );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
        (operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,expires_at)
        VALUES ('pms','room_type.close',$1,$2,'property',$3::uuid,$4::timestamptz+interval '1 year')
        ON CONFLICT DO NOTHING RETURNING id::text`,
          [keyHash, fingerprint, command.propertyId, at.toISOString()],
        );
        const saved = (
          await client.query<{
            id: string;
            fingerprint: string;
            status: string;
            metadata: { result?: PmsRoomClosureSuccess } | null;
          }>(
            `SELECT id::text,request_fingerprint_hash AS fingerprint,status,idempotency_metadata AS metadata
        FROM platform.idempotency_keys WHERE operation_scope='pms' AND operation='room_type.close'
          AND key_hash=$1 AND property_id=$2::uuid AND tenant_scope='property' FOR UPDATE`,
            [keyHash, command.propertyId],
          )
        ).rows[0];
        if (!saved || saved.fingerprint !== fingerprint)
          throw new ClosureRejected("idempotency_key_conflict");
        if (saved.status === "completed") {
          const result = saved.metadata?.result;
          if (
            !result?.ok ||
            result.commandId !== saved.id ||
            result.propertyId !== command.propertyId ||
            result.roomTypeId !== command.roomTypeId ||
            result.phase !== "publication_refresh_required"
          )
            throw new Error("Invalid persisted room closure result");
          return result;
        }
        if (!inserted.rowCount) throw new ClosureRejected("command_in_progress");
        await lockScope(client, command.propertyId);
        const state = await readPmsRoomClosureState(client, command, at);
        if (!state) throw new ClosureRejected("room_type_not_found");
        if (state.blockers.length)
          throw new ClosureRejected("room_closure_protected", state.blockers);
        if (
          state.roomFactsRevision !== command.expectedRoomFactsRevision ||
          state.roomUnitsRevision !== command.expectedRoomUnitsRevision ||
          state.calendarRevision !== command.expectedCalendarRevision ||
          state.activePublicationRevisionId !== command.expectedActivePublicationRevisionId
        )
          throw new ClosureRejected("room_closure_revision_conflict");
        if (!state.cutoffDate || !state.coverageThrough || !state.calendarRevision)
          throw new ClosureRejected("room_closure_protected", ["coverage_incomplete"]);
        try {
          await verifyChannexRoomClosure(
            client,
            config.channex,
            {
              propertyId: command.propertyId,
              roomTypeId: command.roomTypeId,
              from: state.cutoffDate,
              through: state.coverageThrough,
            },
            config.fetch,
          );
        } catch (error) {
          if (error instanceof Error && /^channex_closure_[a-z_]+$/.test(error.message))
            throw new ClosureRejected(error.message);
          throw error;
        }
        const scope = {
          propertyId: command.propertyId,
          roomTypeId: command.roomTypeId,
          commandId: saved.id,
        };
        await client.query(
          `INSERT INTO pms.room_type_closures
        (property_id,room_type_id,command_id,request_fingerprint,expected_room_facts_revision,expected_room_units_revision,
          previous_calendar_revision,closed_calendar_revision,cutoff_date,accepted_at,actor_user_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::bigint,$7::bigint+1,$8::date,$9::timestamptz,$10::uuid)`,
          [
            command.propertyId,
            command.roomTypeId,
            saved.id,
            fingerprint,
            state.roomFactsRevision,
            state.roomUnitsRevision,
            state.calendarRevision,
            state.cutoffDate,
            at.toISOString(),
            command.actorUserId,
          ],
        );
        const phase = {
          calendarRevision: state.calendarRevision + 1,
          cutoffDate: state.cutoffDate,
          phase: "publication_refresh_required" as const,
        };
        const events = await recordPmsRoomClosureEvents(
          client,
          command,
          {
            idempotencyId: saved.id,
            keyHash,
            requestId: command.requestId,
            correlationId: command.correlationId,
          },
          phase,
          at,
        );
        const closedInventoryDays = await closeRoomClosureInventory(client, scope);
        if (closedInventoryDays !== state.futureInventoryDays)
          throw new Error("Closure inventory changed under coordination");
        const units = await retireClosingRoomUnits(client, scope);
        await appendRoomClosureCalendar(client, scope, events);
        const offers = await suppressClosingRoomOffers(client, scope);
        const result: PmsRoomClosureSuccess = {
          ok: true,
          ...scope,
          ...phase,
          ...units,
          closedInventoryDays,
          ...offers,
        };
        const body = JSON.stringify(result);
        await client.query(
          `UPDATE platform.idempotency_keys SET status='completed',completed_at=$2::timestamptz,
          response_status_code=200,response_body_hash=$3,idempotency_metadata=$4::jsonb WHERE id=$1::uuid`,
          [saved.id, at.toISOString(), hash(body), JSON.stringify({ result })],
        );
        return result;
      }),
  };
  async function transaction<T>(
    scope: PmsRoomClosureScope,
    work: (client: pg.PoolClient, at: Date) => Promise<T>,
  ): Promise<T | Failure> {
    const at = now();
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid room closure clock");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockPmsManageScope(client, scope, at)))
        throw new ClosureRejected("setup_scope_unavailable");
      const result = await work(client, at);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // Preserve the command failure if the connection also fails during rollback.
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof ClosureRejected)
        return {
          ok: false,
          error: { code: error.code, ...(error.blockers ? { blockers: error.blockers } : {}) },
        };
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockScope(client: pg.PoolClient, propertyId: string): Promise<void> {
  await lockPmsInventoryMutationScope(client, propertyId);
  await lockPmsRoomFactsMutationScope(client, propertyId);
  const rooms = await client.query<{ id: string }>(
    "SELECT id::text FROM pms.room_types WHERE property_id=$1::uuid ORDER BY id",
    [propertyId],
  );
  for (const room of rooms.rows)
    await lockPmsPhysicalRoomUnitMutationScope(client, propertyId, room.id);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('booking.publication'),hashtext($1::uuid::text))",
    [propertyId],
  );
  await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR SHARE", [
    propertyId,
  ]);
  await client.query(
    "SELECT property_id FROM hotel_catalog.property_locations WHERE property_id=$1::uuid FOR SHARE",
    [propertyId],
  );
}
