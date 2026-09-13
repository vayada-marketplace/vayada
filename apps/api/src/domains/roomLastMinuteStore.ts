import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool } from "pg";
import { parseRoomLastMinutePolicy } from "./lastMinutePolicy.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { PricingStorageError, type PricingStorageScope } from "./replacementPricingStore.js";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fail = (code: PricingStorageError["code"]): never => {
  throw new PricingStorageError(code);
};
export function createRoomLastMinuteStore(pool: Pool) {
  return {
    async save(context: RequestContext | null, scope: PricingStorageScope, input: unknown) {
      if (
        ![scope.propertyId, scope.organizationId, scope.actorUserId].every(uuid) ||
        !pricingObject(input) ||
        !pricingKeys(input, ["requestId", "roomTypeId", "expectedRevision", "policy"]) ||
        !uuid(input.roomTypeId) ||
        !(input.expectedRevision === null || uuid(input.expectedRevision)) ||
        typeof input.requestId !== "string" ||
        !input.requestId.length ||
        input.requestId.length > 200 ||
        input.requestId !== input.requestId.trim()
      )
        return fail("invalid");
      const policy = parseRoomLastMinutePolicy(input.policy);
      if (!policy) return fail("invalid");
      const target = {
        propertyId: scope.propertyId.toLowerCase(),
        organizationId: scope.organizationId.toLowerCase(),
        actorUserId: scope.actorUserId.toLowerCase(),
      };
      const command = {
        requestId: input.requestId,
        roomTypeId: input.roomTypeId.toLowerCase(),
        expectedRevision: input.expectedRevision?.toLowerCase() ?? null,
        policy,
      };
      const trusted = structuredClone(context),
        hash = createHash("sha256").update(JSON.stringify({ target, command })).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (
          !(await lockReplacementPricingAuthorization(client, trusted, target, "manage")) ||
          !(await lockPmsPricingRoomScope(client, target.propertyId, command.roomTypeId))
        )
          return fail("denied");
        const prior = (
          await client.query(
            "SELECT revision,request_hash FROM booking.room_last_minute_revisions WHERE property_id=$1 AND request_id=$2",
            [target.propertyId, command.requestId],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== hash) return fail("idempotency_conflict");
          await client.query("COMMIT");
          return { revision: prior.revision as string, replayed: true };
        }
        const head = (
          await client.query(
            "SELECT revision FROM booking.room_last_minute_heads WHERE property_id=$1 AND room_type_id=$2 FOR UPDATE",
            [target.propertyId, command.roomTypeId],
          )
        ).rows[0];
        if ((head?.revision ?? null) !== command.expectedRevision) return fail("stale");
        const revision = randomUUID();
        await client.query(
          `INSERT INTO booking.room_last_minute_revisions(property_id,room_type_id,revision,policy,organization_id,actor_user_id,request_id,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            target.propertyId,
            command.roomTypeId,
            revision,
            policy,
            target.organizationId,
            target.actorUserId,
            command.requestId,
            hash,
          ],
        );
        await client.query(
          `INSERT INTO booking.room_last_minute_heads(property_id,room_type_id,revision) VALUES($1,$2,$3)
        ON CONFLICT(property_id,room_type_id) DO UPDATE SET revision=$3`,
          [target.propertyId, command.roomTypeId, revision],
        );
        await client.query("COMMIT");
        return { revision, replayed: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
