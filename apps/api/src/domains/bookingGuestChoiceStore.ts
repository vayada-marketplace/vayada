import { createHash, randomUUID } from "node:crypto";
import {
  BOOKING_GUEST_POLICY_AUTHORIZATION,
  parseBookingGuestPolicyChoices,
  type BookingGuestPolicyScopeAuthorizationPort,
} from "@vayada/domain-booking";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool } from "pg";
import type { BookingGuestPolicyReadClient } from "./bookingGuestPolicyRepository.js";

type Scope = { propertyId: string; organizationId: string; actorUserId: string };
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const lock = (client: BookingGuestPolicyReadClient, propertyId: string) =>
  client.query(
    "SELECT pg_advisory_xact_lock(hashtext('booking.guest_policy'), hashtext($1::uuid::text))",
    [propertyId],
  );

/** Caller owns transaction and public scope authorization. No legacy fallback. */
export async function lockCurrentGuestChoiceRevision(
  client: BookingGuestPolicyReadClient,
  propertyId: string,
  organizationId: string,
) {
  if (![propertyId, organizationId].every(uuid)) throw new Error("invalid_guest_choice_scope");
  await lock(client, propertyId);
  const row = (
    await client.query(
      `SELECT r.revision,r.choices FROM booking.guest_choice_heads h
     JOIN booking.guest_choice_revisions r ON r.property_id=h.property_id AND r.revision=h.revision
     WHERE h.property_id=$1 AND r.organization_id=$2`,
      [propertyId, organizationId],
    )
  ).rows[0];
  if (!row) return null;
  const choices = parseBookingGuestPolicyChoices(row.choices);
  if (!choices || !uuid(row.revision)) throw new Error("invalid_stored_guest_choices");
  return {
    propertyId: propertyId.toLowerCase(),
    sourceRevision: `guest-choices:${row.revision}`,
    choices,
  };
}

/** Internal owner; route adapters supply authenticated scope, never body-supplied IDs. */
export function createBookingGuestChoiceStore(
  pool: Pool,
  authorization: BookingGuestPolicyScopeAuthorizationPort,
) {
  return {
    async save(scope: Scope, input: unknown) {
      if (
        ![scope.propertyId, scope.organizationId, scope.actorUserId].every(uuid) ||
        !pricingObject(input) ||
        !pricingKeys(input, ["requestId", "expectedRevision", "confirmed", "choices"]) ||
        input.confirmed !== true ||
        !(input.expectedRevision === null || uuid(input.expectedRevision)) ||
        typeof input.requestId !== "string" ||
        !input.requestId.length ||
        input.requestId.length > 200 ||
        input.requestId !== input.requestId.trim()
      )
        throw new Error("invalid_guest_choices");
      const choices = parseBookingGuestPolicyChoices(input.choices);
      if (!choices) throw new Error("invalid_guest_choices");
      const target = {
        propertyId: scope.propertyId.toLowerCase(),
        organizationId: scope.organizationId.toLowerCase(),
        actorUserId: scope.actorUserId.toLowerCase(),
      };
      const command = {
        requestId: input.requestId,
        expectedRevision: input.expectedRevision?.toLowerCase() ?? null,
        choices,
      };
      const hash = createHash("sha256")
        .update(
          JSON.stringify({ target, command }, (_key, value) =>
            pricingObject(value)
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, value[key]]),
                )
              : value,
          ),
        )
        .digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await lock(client, target.propertyId);
        const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
        if (
          !(await authorization.authorizeGuestPolicyScope({
            ...target,
            ...BOOKING_GUEST_POLICY_AUTHORIZATION,
            checkedAt: now.toISOString(),
          }))
        )
          throw new Error("guest_choices_denied");
        const prior = (
          await client.query(
            "SELECT revision,request_hash FROM booking.guest_choice_revisions WHERE property_id=$1 AND request_id=$2",
            [target.propertyId, command.requestId],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== hash) throw new Error("guest_choices_idempotency_conflict");
          await client.query("COMMIT");
          return { revision: prior.revision as string, replayed: true };
        }
        const current = (
          await client.query(
            "SELECT revision FROM booking.guest_choice_heads WHERE property_id=$1 FOR UPDATE",
            [target.propertyId],
          )
        ).rows[0];
        if ((current?.revision ?? null) !== command.expectedRevision)
          throw new Error("guest_choices_stale");
        const revision = randomUUID();
        await client.query(
          `INSERT INTO booking.guest_choice_revisions(revision,property_id,organization_id,actor_user_id,choices,request_id,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            revision,
            target.propertyId,
            target.organizationId,
            target.actorUserId,
            choices,
            command.requestId,
            hash,
          ],
        );
        await client.query(
          `INSERT INTO booking.guest_choice_heads(property_id,revision) VALUES($1,$2)
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
