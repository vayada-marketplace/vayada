import { createHash } from "node:crypto";

import {
  HOTEL_PROPERTY_DELETION_CONTRACT_VERSION,
  canTransitionPlatformProperty,
  propertyDeletionNameMatches,
  type HotelPropertyDeletionBlocker,
  type HotelPropertyDeletionCheck,
  type PlatformPropertyLifecycleResult,
  type PlatformPropertyLifecycleStatus,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { lockBookingPublication } from "./bookingPublicationLock.js";
import {
  completeIdempotency,
  findReplay,
  inTransaction,
  PlatformPropertyLifecycleError,
  recordAudit,
  removePublicExposure,
  reserveIdempotency,
  retireProperty,
  type CommandClient,
  type CommandPool,
  type PlatformPropertyLifecycleAudit,
} from "./platformPropertyLifecycleCommandRepository.js";

/**
 * VAY-2493: the account admin (the active `hotel_owner` member) deletes one of the account's properties.
 * Deleting is the staff retirement (VAY-1280) run for the hotel: the property is retired, its booking page
 * goes offline and it leaves the property switchers; bookings, payments and audit history stay. It is
 * refused while it would leave the account without a property, or while the property has upcoming
 * bookings, a connected channel manager, or open payments or payouts.
 */
export type HotelPropertyDeletionRepository = {
  check(input: HotelPropertyDeletionScope): Promise<HotelPropertyDeletionCheck | null>;
  delete(input: HotelPropertyDeletionCommand): Promise<PlatformPropertyLifecycleResult>;
  close(): Promise<void>;
};

export type HotelPropertyDeletionScope = {
  organizationId: string;
  actorUserId: string;
  propertyId: string;
};

export type HotelPropertyDeletionCommand = HotelPropertyDeletionScope & {
  expectedLifecycleRevision: number;
  confirmationName: string;
  idempotencyKey: string;
  audit: Omit<PlatformPropertyLifecycleAudit, "actorUserId" | "organizationId">;
};

export type HotelPropertyDeletionErrorCode =
  | "account_admin_required"
  | "property_not_found"
  | "property_already_deleted"
  | "lifecycle_revision_conflict"
  | "confirmation_name_mismatch"
  | "deletion_blocked"
  | "property_busy"
  | "idempotency_key_conflict"
  | "command_in_progress";

export class HotelPropertyDeletionError extends Error {
  constructor(
    readonly code: HotelPropertyDeletionErrorCode,
    readonly check?: HotelPropertyDeletionCheck,
  ) {
    super(code);
  }
}

const OPERATION = "hotel_catalog.property.account_delete";
const REASON = "Deleted by the account admin in Manage Properties (VAY-2493).";

type QueryPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type CheckRow = {
  propertyId: string;
  displayName: string;
  lifecycleStatus: PlatformPropertyLifecycleStatus;
  lifecycleRevision: number | string;
  accountProperties: number | string;
  upcomingBookings: number | string;
  connectedChannels: number | string;
  unresolvedPayments: number | string;
  openPayouts: number | string;
  otherAccounts: number | string;
};

export function createPgHotelPropertyDeletionRepository(config: {
  connectionString?: string;
  pool?: CommandPool & QueryPool;
  now?: () => Date;
}): HotelPropertyDeletionRepository {
  if (!config.pool && !config.connectionString?.trim()) {
    throw new Error("Hotel property deletion connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: CommandPool & QueryPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString });
  const now = config.now ?? (() => new Date());
  return {
    async check(input) {
      if (!(await isAccountAdmin(pool, input, false))) {
        throw new HotelPropertyDeletionError("account_admin_required");
      }
      const check = await readDeletionCheck(pool, input, now());
      return check && check.lifecycleStatus !== "retired" ? check.result : null;
    },
    delete: (input) => runDeletion(pool, input, now()),
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function runDeletion(
  pool: CommandPool,
  input: HotelPropertyDeletionCommand,
  at: Date,
): Promise<PlatformPropertyLifecycleResult> {
  try {
    return await inTransaction(pool, async (client) => {
      // A delete waits behind short writers only; a long wait answers "try again" instead of pinning
      // a pooled connection (see the 2026-10-21 pool starvation).
      await client.query("SET LOCAL lock_timeout = '5s'");
      if (!(await isAccountAdmin(client, input, true))) {
        throw new HotelPropertyDeletionError("account_admin_required");
      }
      await lockBookingPublication(client, input.propertyId);
      // Lock every property of the account that is not deleted, in id order, before reading anything:
      // two deletes in one account then run one after the other, and the second sees the first one's
      // result, so together they can't remove the last property. FOR NO KEY UPDATE also waits for a
      // Booking writer holding the property FOR SHARE, so its booking is counted (VAY-2485).
      await client.query(
        `SELECT property.id
         FROM identity.organization_resource_links link
         JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
         WHERE link.organization_id = $1::uuid
           AND link.product = 'hotel_catalog' AND link.resource_type = 'property'
           AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
           AND property.lifecycle_status <> 'retired'
         ORDER BY property.id
         FOR NO KEY UPDATE OF property`,
        [input.organizationId],
      );
      const fingerprint = sha256(
        JSON.stringify({
          organizationId: input.organizationId,
          propertyId: input.propertyId,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
        }),
      );
      const replay = await findReplay(client, OPERATION, input, fingerprint);
      if (replay) return replay;

      const current = await readDeletionCheck(client, input, at);
      if (!current) throw new HotelPropertyDeletionError("property_not_found");
      if (!canTransitionPlatformProperty(current.lifecycleStatus, "retired")) {
        throw new HotelPropertyDeletionError("property_already_deleted");
      }
      if (current.result.lifecycleRevision !== input.expectedLifecycleRevision) {
        throw new HotelPropertyDeletionError("lifecycle_revision_conflict", current.result);
      }
      if (!propertyDeletionNameMatches(input.confirmationName, current.result.displayName)) {
        throw new HotelPropertyDeletionError("confirmation_name_mismatch");
      }
      if (!current.result.canDelete) {
        throw new HotelPropertyDeletionError("deletion_blocked", current.result);
      }

      const command = {
        propertyId: input.propertyId,
        reason: REASON,
        idempotencyKey: input.idempotencyKey,
        audit: {
          ...input.audit,
          actorUserId: input.actorUserId,
          organizationId: input.organizationId,
        },
      };
      const reservationId = await reserveIdempotency(client, OPERATION, command, fingerprint, at);
      const result = await retireProperty(
        client,
        { ...command, expectedLifecycleRevision: input.expectedLifecycleRevision },
        at,
      );
      await removePublicExposure(client, command, at);
      await recordAudit(client, OPERATION, command, result, reservationId, at);
      await completeIdempotency(client, reservationId, result, at);
      return result;
    });
  } catch (error) {
    throw toDeletionError(error);
  }
}

function toDeletionError(error: unknown): unknown {
  if (error instanceof PlatformPropertyLifecycleError) {
    if (error.code === "idempotency_key_conflict" || error.code === "command_in_progress") {
      return new HotelPropertyDeletionError(error.code);
    }
    return error;
  }
  // 55P03 lock_not_available: lock_timeout ran out behind another writer.
  if ((error as { code?: unknown } | null)?.code === "55P03") {
    return new HotelPropertyDeletionError("property_busy");
  }
  return error;
}

/** The account admin is the active hotel_owner member of the active account (as for the agreements). */
async function isAccountAdmin(
  query: QueryPool | CommandClient,
  input: HotelPropertyDeletionScope,
  lock: boolean,
): Promise<boolean> {
  const result = await query.query(
    `SELECT membership.id
     FROM identity.organization_memberships membership
     JOIN identity.organizations organization
       ON organization.id = membership.organization_id
      AND organization.kind = 'hotel_group' AND organization.status = 'active'
     JOIN identity.users person ON person.id = membership.user_id AND person.status = 'active'
     WHERE membership.organization_id = $1::uuid AND membership.user_id = $2::uuid
       AND membership.status = 'active' AND membership.role_key = 'hotel_owner'
     ${lock ? "FOR SHARE OF membership, person" : ""}`,
    [input.organizationId, input.actorUserId],
  );
  return result.rows.length === 1;
}

async function readDeletionCheck(
  query: QueryPool | CommandClient,
  input: HotelPropertyDeletionScope,
  at: Date,
): Promise<{
  lifecycleStatus: PlatformPropertyLifecycleStatus;
  result: HotelPropertyDeletionCheck;
} | null> {
  const result = await query.query<CheckRow>(DELETION_CHECK_SQL, [
    input.organizationId,
    input.propertyId,
    at.toISOString(),
  ]);
  const row = result.rows[0];
  if (!row) return null;
  const accountProperties = count(row.accountProperties);
  const blockers: HotelPropertyDeletionBlocker[] = [
    // The property itself is one of the account's properties unless it is already deleted.
    { code: "last_property" as const, count: accountProperties < 2 ? 1 : 0 },
    { code: "upcoming_bookings" as const, count: count(row.upcomingBookings) },
    { code: "connected_channels" as const, count: count(row.connectedChannels) },
    { code: "unresolved_payments" as const, count: count(row.unresolvedPayments) },
    { code: "open_payouts" as const, count: count(row.openPayouts) },
    { code: "shared_property" as const, count: count(row.otherAccounts) },
  ].filter((blocker) => blocker.count > 0);
  return {
    lifecycleStatus: row.lifecycleStatus,
    result: {
      contractVersion: HOTEL_PROPERTY_DELETION_CONTRACT_VERSION,
      propertyId: row.propertyId,
      displayName: row.displayName,
      lifecycleRevision: count(row.lifecycleRevision),
      accountProperties,
      blockers,
      canDelete: blockers.length === 0 && row.lifecycleStatus !== "retired",
    },
  };
}

/**
 * One property of the account (an active owner/operator link) with what blocks its deletion:
 * - upcoming bookings: paid or awaiting payment, checking out today or later in the property's own time
 *   zone (UTC when it has none or PostgreSQL doesn't know it); drafts and past stays don't block;
 * - connected channels: the staff retirement's connected statuses;
 * - open payments: the staff retirement's open statuses, plus vayada Payment card refunds still pending;
 * - open payouts: the staff retirement's open payouts, plus vayada Payment payouts started but not sent
 *   or returned, plus each currency in which Vayada still owes the property live vayada Payment money
 *   (VAY-2442 ledger; a property that owes Vayada after a refund is settled by staff, not by waiting);
 * - other accounts: deleting retires the property for everyone, so one shared with another account is
 *   left to Vayada support.
 */
const DELETION_CHECK_SQL = `
  WITH account_property_links AS (
    SELECT DISTINCT link.resource_id
    FROM identity.organization_resource_links link
    WHERE link.organization_id = $1::uuid
      AND link.product = 'hotel_catalog' AND link.resource_type = 'property'
      AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
  )
  SELECT property.id::text AS "propertyId",
    property.display_name AS "displayName",
    property.lifecycle_status AS "lifecycleStatus",
    property.lifecycle_revision AS "lifecycleRevision",
    (SELECT count(*) FROM account_property_links account_link
     JOIN hotel_catalog.properties account_property
       ON account_property.id::text = account_link.resource_id
     WHERE account_property.lifecycle_status <> 'retired') AS "accountProperties",
    (SELECT count(*) FROM booking.guest_bookings booking
     WHERE booking.property_id = property.id
       AND booking.lifecycle_status IN ('pending_payment', 'confirmed')
       AND booking.check_out >= ($3::timestamptz AT TIME ZONE COALESCE(
         (SELECT zone.name FROM pg_timezone_names zone WHERE zone.name = location.timezone),
         'UTC'))::date) AS "upcomingBookings",
    (SELECT count(*) FROM pms.channel_connections connection
     WHERE connection.property_id = property.id
       AND connection.connection_status IN ('connected', 'degraded')) AS "connectedChannels",
    (SELECT count(*) FROM finance.payments payment
     WHERE payment.property_id = property.id
       AND payment.status IN ('requires_action', 'authorized', 'pending', 'disputed'))
      + (SELECT count(*) FROM finance.card_refund_commands refund
         WHERE refund.property_id = property.id AND refund.status = 'pending')
      AS "unresolvedPayments",
    (SELECT count(*) FROM finance.payouts payout
     WHERE (payout.property_id = property.id OR payout.related_property_id = property.id)
       AND payout.payout_status IN ('pending', 'scheduled', 'processing', 'failed'))
      + (SELECT count(*) FROM finance.hotel_payouts hotel_payout
         WHERE hotel_payout.property_id = property.id AND hotel_payout.livemode
           AND hotel_payout.sent_at IS NULL AND hotel_payout.returned_at IS NULL)
      + (SELECT count(*) FROM (
           SELECT ledger.currency FROM finance.hotel_payout_ledger ledger
           WHERE ledger.property_id = property.id AND ledger.livemode
           GROUP BY ledger.currency HAVING sum(ledger.net_minor) > 0) owed)
      AS "openPayouts",
    (SELECT count(DISTINCT other.organization_id) FROM identity.organization_resource_links other
     JOIN identity.organizations other_account
       ON other_account.id = other.organization_id
      AND other_account.kind = 'hotel_group' AND other_account.status = 'active'
     WHERE other.resource_id = property.id::text
       AND other.product = 'hotel_catalog' AND other.resource_type = 'property'
       AND other.status = 'active' AND other.organization_id <> $1::uuid) AS "otherAccounts"
  FROM hotel_catalog.properties property
  LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
  WHERE property.id = $2::uuid
    AND EXISTS (SELECT 1 FROM account_property_links account_link
                WHERE account_link.resource_id = property.id::text)`;

function count(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid deletion check count");
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
