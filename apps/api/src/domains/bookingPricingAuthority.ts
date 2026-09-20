import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { PricingStorageError, type PricingStorageScope } from "./replacementPricingStore.js";

export type BookingPricingAuthority = Readonly<{
  authority: "unconfigured" | "vayada" | "external";
  revision: string | null;
  organizationId: string | null;
}>;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const authority = (v: unknown): v is BookingPricingAuthority["authority"] =>
  typeof v === "string" && ["unconfigured", "vayada", "external"].includes(v);
const fail = (code: PricingStorageError["code"]): never => {
  throw new PricingStorageError(code);
};

/** Internal owner read. Caller must own the transaction and authorize property access.
 * The choice is not public visibility, executable provider readiness or current price evidence. */
export async function lockBookingPricingAuthority(
  client: PoolClient,
  propertyId: string,
): Promise<BookingPricingAuthority> {
  if (!uuid(propertyId)) return fail("invalid");
  await lockPmsInventoryMutationScope(client, propertyId);
  const row = (
    await client.query(
      `SELECT r.authority,r.revision,r.organization_id FROM booking.pricing_authority_heads h
    JOIN booking.pricing_authority_revisions r USING(property_id,revision) WHERE h.property_id=$1 FOR SHARE OF h,r`,
      [propertyId],
    )
  ).rows[0];
  if (!row) return { authority: "unconfigured", revision: null, organizationId: null };
  if (!authority(row.authority) || !uuid(row.revision) || !uuid(row.organization_id))
    return fail("invalid");
  return { authority: row.authority, revision: row.revision, organizationId: row.organization_id };
}

/** Staff-only explicit choice. No publication/channel connection implicitly calls this command. */
export function createBookingPricingAuthorityStore(pool: Pool) {
  return {
    async read(context: RequestContext | null, scope: PricingStorageScope) {
      if (![scope.propertyId, scope.organizationId, scope.actorUserId].every(uuid))
        return fail("invalid");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockReplacementPricingAuthorization(client, context, scope, "read")))
          return fail("denied");
        const current = await lockBookingPricingAuthority(client, scope.propertyId);
        await client.query("COMMIT");
        return current;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async save(context: RequestContext | null, scope: PricingStorageScope, input: unknown) {
      if (
        ![scope.propertyId, scope.organizationId, scope.actorUserId].every(uuid) ||
        !pricingObject(input) ||
        !pricingKeys(input, ["requestId", "expectedRevision", "authority"]) ||
        !authority(input.authority) ||
        !(input.expectedRevision === null || uuid(input.expectedRevision)) ||
        typeof input.requestId !== "string" ||
        input.requestId !== input.requestId.trim() ||
        input.requestId.length < 1 ||
        input.requestId.length > 200
      )
        return fail("invalid");
      const target = {
        propertyId: scope.propertyId.toLowerCase(),
        organizationId: scope.organizationId.toLowerCase(),
        actorUserId: scope.actorUserId.toLowerCase(),
      };
      const command = {
        requestId: input.requestId,
        expectedRevision: input.expectedRevision?.toLowerCase() ?? null,
        authority: input.authority,
      };
      const trustedContext = structuredClone(context);
      const hash = createHash("sha256").update(JSON.stringify({ target, command })).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockReplacementPricingAuthorization(client, trustedContext, target, "manage")))
          return fail("denied");
        const prior = (
          await client.query(
            `SELECT revision,request_hash FROM booking.pricing_authority_revisions
          WHERE property_id=$1 AND request_id=$2`,
            [target.propertyId, command.requestId],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== hash) return fail("idempotency_conflict");
          await client.query("COMMIT");
          return { revision: prior.revision as string, replayed: true };
        }
        const current = await lockBookingPricingAuthority(client, target.propertyId);
        if (current.revision !== command.expectedRevision) return fail("stale");
        const revision = randomUUID();
        await client.query(
          `INSERT INTO booking.pricing_authority_revisions
          (property_id,revision,authority,organization_id,actor_user_id,request_id,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            target.propertyId,
            revision,
            command.authority,
            target.organizationId,
            target.actorUserId,
            command.requestId,
            hash,
          ],
        );
        await client.query(
          `INSERT INTO booking.pricing_authority_heads(property_id,revision) VALUES($1,$2)
          ON CONFLICT(property_id) DO UPDATE SET revision=$2`,
          [target.propertyId, revision],
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
