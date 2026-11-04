import { createHash } from "node:crypto";

import type pg from "pg";

import { workosUserPayloadFromData, type WorkosUserPayload } from "../routes/workosWebhooks.js";
import { lockWorkosProviderIdentity } from "./workosIdentityLock.js";
import { updateLinkedWorkosUser } from "./workosWebhooks.js";

// VAY-2479: from 20 Sep to 4 Nov 2026 the legacy-owner guard dead-lettered WorkOS user webhooks
// for existing users (VAY-2478), and WorkOS never resends them. This one-off re-reads each of
// those users from WorkOS and applies the webhook's own update (updateLinkedWorkosUser), then
// resolves their dead letters. It only updates linked users: it never creates a user, touches
// memberships, writes to WorkOS or sends email. Smoke (.test) dead letters are acknowledged.
// A dry run reads only; an apply re-plans and refuses unless the plan still has the same SHA-256.

export const WORKOS_USER_RESYNC_REASON_CODE = "identity_reconciliation_failed";
export const WORKOS_USER_RESYNC_FAILURE_SUMMARY = "Legacy owner account reconciliation required";
const SMOKE_EMAIL = /\.test$/;

export type WorkosUserReader = {
  /** The user as WorkOS has it now, or null when WorkOS has no user with this ID. Read-only. */
  getUser(workosUserId: string): Promise<Record<string, unknown> | null>;
};

export type WorkosUserResyncOutcome =
  /** Linked, and WorkOS differs in at least one field: the webhook update runs. */
  | "update"
  /** Linked and already equal to WorkOS: only the dead letters are resolved. */
  | "in_sync"
  /** Deleted with us: the webhook update ignores it on purpose (VAY-2272). Dead letters resolved. */
  | "user_deleted"
  /** Skipped and reported, dead letters left open. */
  | "missing_in_workos"
  | "not_linked"
  | "legacy_owner_protected";

const RESOLVED_OUTCOMES = new Set<WorkosUserResyncOutcome>(["update", "in_sync", "user_deleted"]);

type DeadLetter = { deadLetterId: string; receiptId: string };

type TrackedFields = {
  email: string;
  name: string | null;
  status: string;
  providerEmail: string | null;
  providerEmailVerified: boolean | null;
};

// Printed names for the tracked fields. Values are never printed.
const FIELD_NAMES: Record<keyof TrackedFields, string> = {
  email: "email",
  name: "name",
  status: "status",
  providerEmail: "provider_email",
  providerEmailVerified: "email_verified",
};

export type WorkosUserResyncPlannedUser = {
  workosUserId: string;
  userId: string | null;
  outcome: WorkosUserResyncOutcome;
  changes: string[];
  deadLetters: DeadLetter[];
  /** SHA-256 of the tracked fields before and after; binds the plan to the exact values. */
  before: string | null;
  after: string | null;
  payload: WorkosUserPayload | null;
};

export type WorkosUserResyncPlan = {
  planSha256: string;
  users: WorkosUserResyncPlannedUser[];
  smoke: { deadLetterIds: string[]; users: number; usersNotDeleted: number };
};

export type WorkosUserResyncResult = {
  usersUpdated: number;
  usersResolvedWithoutChange: number;
  usersDeleted: number;
  usersSkipped: number;
  deadLettersResolved: number;
  deadLettersAcknowledged: number;
};

export class WorkosUserResyncRefusal extends Error {
  constructor(
    readonly code: string,
    /** The short reference of the user the refusal is about, when there is one. */
    readonly ref?: string,
  ) {
    super(code);
    this.name = "WorkosUserResyncRefusal";
  }
}

export type WorkosUserResyncProgress = {
  ref: string;
  outcome: WorkosUserResyncOutcome;
  deadLettersResolved: number;
};

export function parseWorkosUserResyncArgs(argv: string[]): {
  approvalRef: string;
  applyPlanSha256: string | null;
} {
  let approvalRef: string | null = null;
  let applyPlanSha256: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--approval-ref" && value !== undefined && approvalRef === null) {
      approvalRef = value;
    } else if (flag === "--apply" && value !== undefined && applyPlanSha256 === null) {
      applyPlanSha256 = value;
    } else {
      throw new WorkosUserResyncRefusal("arguments_invalid");
    }
    index += 1;
  }
  if (!approvalRef || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/.test(approvalRef)) {
    throw new WorkosUserResyncRefusal("approval_ref_invalid");
  }
  if (applyPlanSha256 !== null && !/^[0-9a-f]{64}$/.test(applyPlanSha256)) {
    throw new WorkosUserResyncRefusal("plan_sha256_invalid");
  }
  return { approvalRef, applyPlanSha256 };
}

/**
 * Read-only: the database reads run in one READ ONLY transaction that is rolled back before any
 * WorkOS call, and WorkOS is only read. The apply re-checks each user under a lock anyway.
 */
export async function planWorkosUserResync(input: {
  pool: pg.Pool;
  workos: WorkosUserReader;
}): Promise<WorkosUserResyncPlan> {
  const client = await input.pool.connect();
  let cohort: Cohort;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      cohort = await readCohort(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
  return buildPlan(cohort, input.workos);
}

export async function applyWorkosUserResync(input: {
  pool: pg.Pool;
  workos: WorkosUserReader;
  planSha256: string;
  approvalRef: string;
  /** Called after each user's transaction commits, so a stopped run shows how far it got. */
  onProgress?: (progress: WorkosUserResyncProgress) => void;
}): Promise<WorkosUserResyncResult> {
  const plan = await planWorkosUserResync(input);
  if (plan.planSha256 !== input.planSha256) throw new WorkosUserResyncRefusal("plan_changed");

  const result: WorkosUserResyncResult = {
    usersUpdated: 0,
    usersResolvedWithoutChange: 0,
    usersDeleted: 0,
    usersSkipped: 0,
    deadLettersResolved: 0,
    deadLettersAcknowledged: 0,
  };
  for (const user of plan.users) {
    if (!RESOLVED_OUTCOMES.has(user.outcome)) {
      result.usersSkipped += 1;
      continue;
    }
    await applyUser(input.pool, user, input.approvalRef);
    input.onProgress?.({
      ref: shortRef(user.workosUserId),
      outcome: user.outcome,
      deadLettersResolved: user.deadLetters.length,
    });
    result.deadLettersResolved += user.deadLetters.length;
    if (user.outcome === "update") result.usersUpdated += 1;
    else if (user.outcome === "in_sync") result.usersResolvedWithoutChange += 1;
    else result.usersDeleted += 1;
  }
  if (plan.smoke.deadLetterIds.length > 0) {
    result.deadLettersAcknowledged = await acknowledgeSmokeDeadLetters(
      input.pool,
      plan.smoke.deadLetterIds,
    );
  }
  return result;
}

/** What the CLI prints: short references, outcomes, field names and counts. No values. */
export function summarizeWorkosUserResyncPlan(plan: WorkosUserResyncPlan) {
  const count = (outcomes: WorkosUserResyncOutcome[]) =>
    plan.users.filter((user) => outcomes.includes(user.outcome)).length;
  const deadLetters = (resolved: boolean) =>
    plan.users
      .filter((user) => RESOLVED_OUTCOMES.has(user.outcome) === resolved)
      .reduce((total, user) => total + user.deadLetters.length, 0);
  return {
    users: plan.users.map((user) => ({
      ref: shortRef(user.workosUserId),
      outcome: user.outcome,
      changes: user.changes,
      deadLetters: user.deadLetters.length,
    })),
    totals: {
      users: plan.users.length,
      update: count(["update"]),
      inSync: count(["in_sync"]),
      userDeleted: count(["user_deleted"]),
      skipped: count(["missing_in_workos", "not_linked", "legacy_owner_protected"]),
      deadLettersToResolve: deadLetters(true),
      deadLettersLeftOpen: deadLetters(false),
    },
    smoke: {
      deadLettersToAcknowledge: plan.smoke.deadLetterIds.length,
      users: plan.smoke.users,
      usersNotDeleted: plan.smoke.usersNotDeleted,
    },
  };
}

type LinkedRow = {
  workos_user_id: string;
  user_id: string;
  email: string;
  name: string | null;
  status: string;
  provider_email: string | null;
  provider_email_verified: boolean | null;
};

type Cohort = {
  groups: Map<string, { deadLetters: DeadLetter[]; smokePayload: boolean }>;
  linked: Map<string, LinkedRow>;
  protectedUserIds: Set<string>;
};

async function readCohort(client: pg.PoolClient): Promise<Cohort> {
  const deadLetterRows = await client.query<{
    dead_letter_id: string;
    receipt_id: string;
    workos_user_id: string;
    smoke_payload: boolean;
  }>(
    `SELECT dead.id::text AS dead_letter_id,
            receipt.id::text AS receipt_id,
            receipt.raw_payload -> 'data' ->> 'id' AS workos_user_id,
            COALESCE((receipt.raw_payload -> 'data' ->> 'email') ~ '[.]test$', false) AS smoke_payload
     FROM platform.dead_letter_events AS dead
     JOIN platform.external_webhook_events AS receipt ON receipt.id = dead.webhook_event_id
     WHERE dead.source_kind = 'webhook'
       AND dead.resource_product = 'identity'
       AND dead.resource_type = 'workos_webhook'
       AND dead.reason_code = $1
       AND dead.failure_summary = $2
       AND dead.recovery_status = 'open'
       AND receipt.provider = 'workos'
       AND receipt.event_type IN ('user.created', 'user.updated')
       AND receipt.raw_payload -> 'data' ->> 'id' IS NOT NULL
     ORDER BY dead.id`,
    [WORKOS_USER_RESYNC_REASON_CODE, WORKOS_USER_RESYNC_FAILURE_SUMMARY],
  );

  const groups = new Map<string, { deadLetters: DeadLetter[]; smokePayload: boolean }>();
  for (const row of deadLetterRows.rows) {
    const group = groups.get(row.workos_user_id) ?? { deadLetters: [], smokePayload: true };
    group.deadLetters.push({ deadLetterId: row.dead_letter_id, receiptId: row.receipt_id });
    group.smokePayload &&= row.smoke_payload;
    groups.set(row.workos_user_id, group);
  }

  const linkedRows = await client.query<LinkedRow>(
    `SELECT external.provider_user_id AS workos_user_id,
            users.id::text AS user_id,
            users.email,
            users.name,
            users.status,
            external.provider_email,
            external.provider_email_verified
     FROM identity.external_identities AS external
     JOIN identity.users AS users ON users.id = external.user_id
     WHERE external.provider = 'workos'
       AND external.provider_user_id = ANY($1::text[])`,
    [[...groups.keys()]],
  );
  const linked = new Map(linkedRows.rows.map((row) => [row.workos_user_id, row]));

  // The guard's own read, but a read error refuses the run instead of reading as "protected":
  // an unreadable receipts table is how VAY-2478 started.
  let protectedRows: pg.QueryResult<{ user_id: string }>;
  try {
    protectedRows = await client.query<{ user_id: string }>(
      `SELECT candidate::text AS user_id
       FROM unnest($1::uuid[]) AS candidate
       WHERE EXISTS (
         SELECT 1 FROM platform.legacy_owner_bootstrap_receipts
         WHERE candidate = ANY(owner_user_ids)
       )`,
      [linkedRows.rows.map((row) => row.user_id)],
    );
  } catch {
    throw new WorkosUserResyncRefusal("legacy_owner_guard_unreadable");
  }
  return {
    groups,
    linked,
    protectedUserIds: new Set(protectedRows.rows.map((row) => row.user_id)),
  };
}

async function buildPlan(
  { groups, linked, protectedUserIds }: Cohort,
  workos: WorkosUserReader,
): Promise<WorkosUserResyncPlan> {
  const users: WorkosUserResyncPlannedUser[] = [];
  const smokeDeadLetterIds: string[] = [];
  let smokeUsers = 0;
  let smokeUsersNotDeleted = 0;
  for (const workosUserId of [...groups.keys()].sort()) {
    const group = groups.get(workosUserId)!;
    const row = linked.get(workosUserId);
    // Smoke: our email, or every webhook email, ends in .test (an erased account's email is rewritten).
    if (group.smokePayload || (row !== undefined && SMOKE_EMAIL.test(row.email))) {
      smokeUsers += 1;
      if (row && row.status !== "deleted") smokeUsersNotDeleted += 1;
      smokeDeadLetterIds.push(...group.deadLetters.map((deadLetter) => deadLetter.deadLetterId));
      continue;
    }
    const planned: WorkosUserResyncPlannedUser = {
      workosUserId,
      userId: row?.user_id ?? null,
      outcome: "not_linked",
      changes: [],
      deadLetters: group.deadLetters,
      before: null,
      after: null,
      payload: null,
    };
    users.push(planned);
    if (!row) continue;

    const before: TrackedFields = {
      email: row.email,
      name: row.name,
      status: row.status,
      providerEmail: row.provider_email,
      providerEmailVerified: row.provider_email_verified,
    };
    planned.before = fingerprint(before);
    if (row.status === "deleted") {
      planned.outcome = "user_deleted";
      continue;
    }
    const fetched = await workos.getUser(workosUserId);
    if (!fetched) {
      planned.outcome = "missing_in_workos";
      continue;
    }
    const payload = workosUserPayloadFromData(fetched);
    if (payload.workosUserId !== workosUserId) {
      throw new WorkosUserResyncRefusal("workos_returned_another_user");
    }
    if (protectedUserIds.has(row.user_id)) {
      planned.outcome = "legacy_owner_protected";
      continue;
    }
    // The same values updateLinkedWorkosUser writes.
    const after: TrackedFields = {
      email: payload.email,
      name: payload.name ?? row.name,
      status:
        row.status === "suspended" && payload.status === "active" ? row.status : payload.status,
      providerEmail: payload.email,
      providerEmailVerified: payload.emailVerified,
    };
    planned.changes = (Object.keys(FIELD_NAMES) as (keyof TrackedFields)[])
      .filter((field) => before[field] !== after[field])
      .map((field) => FIELD_NAMES[field]);
    planned.outcome = planned.changes.length > 0 ? "update" : "in_sync";
    planned.after = fingerprint(after);
    planned.payload = payload;
  }

  smokeDeadLetterIds.sort();
  const planSha256 = sha256(
    JSON.stringify({
      version: 1,
      users: users.map((user) => ({
        workosUserId: user.workosUserId,
        userId: user.userId,
        outcome: user.outcome,
        changes: user.changes,
        deadLetters: user.deadLetters,
        before: user.before,
        after: user.after,
      })),
      smokeDeadLetterIds,
    }),
  );
  return {
    planSha256,
    users,
    smoke: {
      deadLetterIds: smokeDeadLetterIds,
      users: smokeUsers,
      usersNotDeleted: smokeUsersNotDeleted,
    },
  };
}

// One transaction per user: the provider lock the webhook takes, a re-read that must still match
// the plan, the webhook update, and the dead letters resolved with one audit row per receipt.
async function applyUser(
  pool: pg.Pool,
  user: WorkosUserResyncPlannedUser,
  approvalRef: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockWorkosProviderIdentity(client, user.workosUserId);
    const current = await client.query<{
      user_id: string;
      email: string;
      name: string | null;
      status: string;
      provider_email: string | null;
      provider_email_verified: boolean | null;
    }>(
      `SELECT users.id::text AS user_id, users.email, users.name, users.status,
              external.provider_email, external.provider_email_verified
       FROM identity.external_identities AS external
       JOIN identity.users AS users ON users.id = external.user_id
       WHERE external.provider = 'workos' AND external.provider_user_id = $1
       FOR UPDATE OF users`,
      [user.workosUserId],
    );
    const row = current.rows[0];
    if (
      !row ||
      current.rows.length !== 1 ||
      row.user_id !== user.userId ||
      fingerprint({
        email: row.email,
        name: row.name,
        status: row.status,
        providerEmail: row.provider_email,
        providerEmailVerified: row.provider_email_verified,
      }) !== user.before
    ) {
      throw new WorkosUserResyncRefusal("user_changed_since_plan", shortRef(user.workosUserId));
    }
    if (user.outcome === "update") {
      if (!user.payload || !(await updateLinkedWorkosUser(client, row.user_id, user.payload))) {
        throw new WorkosUserResyncRefusal("user_changed_since_plan", shortRef(user.workosUserId));
      }
    }
    const resolved = await client.query(
      `UPDATE platform.dead_letter_events
       SET recovery_status = 'resolved', resolved_at = now()
       WHERE id = ANY($1::uuid[])
         AND source_kind = 'webhook'
         AND reason_code = $2
         AND failure_summary = $3
         AND recovery_status = 'open'`,
      [
        user.deadLetters.map((deadLetter) => deadLetter.deadLetterId),
        WORKOS_USER_RESYNC_REASON_CODE,
        WORKOS_USER_RESYNC_FAILURE_SUMMARY,
      ],
    );
    if (resolved.rowCount !== user.deadLetters.length) {
      throw new WorkosUserResyncRefusal(
        "dead_letters_changed_since_plan",
        shortRef(user.workosUserId),
      );
    }
    // Same audit shape as markReceiptProcessed: a deleted user's event is "ignored" there too.
    const status = user.outcome === "user_deleted" ? "ignored" : "normalized";
    for (const deadLetter of user.deadLetters) {
      await client.query(
        `INSERT INTO identity.auth_reconciliation_events
           (event_type, provider, provider_event_id, user_id, payload, processed_at)
         VALUES ($1, 'workos', $2, $3, $4, now())`,
        [
          `workos.webhook.${status}`,
          deadLetter.receiptId,
          status === "normalized" ? row.user_id : null,
          JSON.stringify({
            receiptId: deadLetter.receiptId,
            status,
            recoveredFrom: WORKOS_USER_RESYNC_REASON_CODE,
            recovery: "workos_user_resync",
            outcome: user.outcome,
            approvalRef,
          }),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function acknowledgeSmokeDeadLetters(
  pool: pg.Pool,
  deadLetterIds: string[],
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const acknowledged = await client.query(
      `UPDATE platform.dead_letter_events
       SET recovery_status = 'acknowledged', acknowledged_at = now()
       WHERE id = ANY($1::uuid[])
         AND source_kind = 'webhook'
         AND reason_code = $2
         AND failure_summary = $3
         AND recovery_status = 'open'`,
      [deadLetterIds, WORKOS_USER_RESYNC_REASON_CODE, WORKOS_USER_RESYNC_FAILURE_SUMMARY],
    );
    if (acknowledged.rowCount !== deadLetterIds.length) {
      throw new WorkosUserResyncRefusal("dead_letters_changed_since_plan");
    }
    await client.query("COMMIT");
    return deadLetterIds.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function fingerprint(fields: TrackedFields): string {
  return sha256(
    JSON.stringify([
      fields.email,
      fields.name,
      fields.status,
      fields.providerEmail,
      fields.providerEmailVerified,
    ]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortRef(workosUserId: string): string {
  return `…${workosUserId.slice(-8)}`;
}
