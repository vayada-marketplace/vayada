// The one executor of AI changes (VAY-2524; design note §4.6). It runs an operation's request as
// the user who asked, with a delegation that may write and only on the operation's property,
// under the operation's lease, and records how it ended. Each step's key is bound to the operation
// (`op_<id>:<step>`, then to the action), so a double click, a take-over after a crash or a resumed
// run sends the same key and the route answers its stored result instead of changing twice.
//
// Only this module mints a delegation that writes (resolveDelegatedChangeContext; a boundary test
// keeps it here). The model, the AI SDK, Mastra and the browser never run a change: they create
// an operation or answer it.
//
// "failed" must mean the change certainly did not happen. A "sent" step is recorded before every
// request, so a run without one never sent anything: it fails before any request, or on its
// route's refusal. Once a request may have gone out, only the route's success ends the run, and
// anything else leaves it running for the recovery job, which sends the same key again until the
// run gives up (outcome unknown).
import { createHash, randomUUID } from "node:crypto";

import {
  AuthError,
  DelegationRefusedError,
  injectAsDelegate,
  resolveDelegatedChangeContext,
  type AuthorizationResolver,
  type IdentityRepository,
  type RequestContext,
} from "@vayada/backend-auth";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import type { AiActionLog, AiActionOutcome, AiRecordRef } from "../actionLog/actionLog.js";
import { argumentKindsOf } from "../actionLog/argumentKinds.js";
import { changeRequest, type ChangeAction } from "../actions/defineChangeAction.js";
import { findChangeAction } from "../actions/registry.js";
import type { AiOperation, AiOperationStore } from "./operationStore.js";

/** How long a run holds its operation; renewed before the request and while it runs. */
export const EXECUTOR_LEASE_MS = 60_000;
/**
 * Answers that mean "try again later" or "this key is already used": the transaction rolled back,
 * or the same request is still running or already ran. Never a final refusal.
 */
const RETRY_CODES = new Set([
  "busy_try_again",
  "command_in_progress",
  "idempotency_conflict",
  "idempotency_key_conflict",
]);
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type AiChangeExecutor = {
  /**
   * The person's Yes: starts the pending change for exactly one caller and runs it. Every other
   * caller (a double click, a second tab) gets the operation as it is and joins that run. Null for
   * an unknown operation. The caller checks who answers before (PR 3).
   */
  startAndRun(operationId: string): Promise<AiOperation | null>;
  /**
   * The recovery job: takes over runs whose lease ran out, one at a time, with the same keys, until
   * `limit` or until `stopping()` says the API is shutting down.
   */
  recover(limit?: number, stopping?: () => boolean): Promise<number>;
  /** Closes pending changes nobody answered in time. */
  expirePending(limit?: number): Promise<number>;
};

/** What a route's answer means for the change (exported for its tests). */
export type ChangeAnswer =
  | { kind: "done"; result: unknown; logOutcome: AiActionOutcome }
  | { kind: "refused" | "unknown"; errorCode: string; logOutcome: AiActionOutcome };

export function createAiChangeExecutor(deps: {
  app: FastifyInstance;
  store: AiOperationStore;
  identity: IdentityRepository;
  authorizationResolver: AuthorizationResolver;
  log: AiActionLog;
  /** This API task, as leases name it (a token is made from it at every start and take-over). */
  holder: string;
  leaseMs?: number;
  /** Hands back a log row that could not be written: the change itself stands. */
  onLogFailure: (error: unknown) => void;
  /** Hands back a run that broke; it stays running and the recovery job takes it over. */
  onRunFailure: (error: unknown, operation: AiOperation) => void;
}): AiChangeExecutor {
  const leaseMs = deps.leaseMs ?? EXECUTOR_LEASE_MS;
  // Wall time only: the delegation's age is checked against the wall clock.
  const now = () => new Date();
  const lease = { holder: deps.holder, ms: leaseMs };

  const runSafely = async (operation: AiOperation) => {
    try {
      await run(operation);
    } catch (error) {
      deps.onRunFailure(error, operation);
    }
  };

  /** Runs an operation this caller holds the lease of (`leaseOwner`). */
  async function run(operation: AiOperation): Promise<void> {
    const token = operation.leaseOwner;
    if (!token) throw new Error("AI change run without its lease");
    // A request may already have gone out (a "sent" step is on record before every request): then
    // nothing but the route's success ends the run.
    const mayHaveSent = operation.steps.length > 0;
    const fail = async (errorCode: string) => {
      if (!mayHaveSent) {
        await deps.store.finish(operation.id, token, { status: "failed", errorCode }, now());
      }
    };
    const action = findChangeAction(`${operation.action}@${operation.actionVersion}`);
    if (!action) return void (await fail("unknown_action"));

    let context: RequestContext;
    try {
      context = await resolveDelegatedChangeContext(
        deps.identity,
        {
          userId: operation.userId,
          organizationId: operation.organizationId,
          delegation:
            operation.surface === "mcp"
              ? {
                  channel: "mcp",
                  connectionId: operation.connectionId ?? undefined,
                  toolCallId: `op_${operation.id}`,
                }
              : {
                  channel: "in_app",
                  conversationId: operation.conversationId ?? undefined,
                  toolCallId: `op_${operation.id}`,
                },
          // The change may touch its own property only.
          propertyIds: [operation.propertyId],
        },
        { authorizationResolver: deps.authorizationResolver },
      );
    } catch (error) {
      // The user, the account or the membership is gone or no longer active.
      if (error instanceof AuthError || error instanceof DelegationRefusedError) {
        return void (await fail("not_allowed"));
      }
      throw error;
    }

    const step = 1;
    const built = changeRequest(action, operation.arguments, `op_${operation.id}:${step}`);
    if (!built.ok) return void (await fail("invalid_input"));
    const requestId = randomUUID();
    const keySha256 = sha256(built.request.idempotencyKey);
    const record = (statusCode: number) =>
      deps.store.recordStep(operation.id, token, {
        step,
        requestId,
        idempotencyKeySha256: keySha256,
        statusCode,
        at: now().toISOString(),
      });
    // Still ours, and on record that a request is about to go out (status 0: no answer yet).
    if (!(await deps.store.renewLease(operation.id, token, leaseMs, now()))) return;
    if (!(await record(0))) return;

    const started = performance.now();
    const log = (outcome: AiActionOutcome, errorCode: string | null, changed: AiRecordRef[]) =>
      deps.log
        .record({
          organizationId: operation.organizationId,
          propertyId: operation.propertyId,
          userId: operation.userId,
          surface: operation.surface,
          client: operation.client,
          connectionId: operation.connectionId,
          conversationId: operation.conversationId,
          action: operation.action,
          actionVersion: operation.actionVersion,
          group: operation.group,
          arguments: operation.arguments,
          argumentKinds: argumentKindsOf(action.input),
          recordsChanged: changed,
          outcome,
          errorCode,
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
          requestId,
          correlationId: `op_${operation.id}`,
          idempotencyKey: built.request.idempotencyKey,
          operationId: operation.id,
        })
        .catch((error: unknown) => deps.onLogFailure(error));

    // Keep the lease while the request runs (record and finish check it again); give up waiting
    // before it could run out.
    const renewer = setInterval(
      () => void deps.store.renewLease(operation.id, token, leaseMs, now()).catch(() => undefined),
      Math.max(1, Math.floor(leaseMs / 3)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sending = injectAsDelegate(deps.app, { context, ...built.request, requestId });
    // A request that fails after the deadline has nobody waiting for it any more.
    sending.catch(() => undefined);
    let response: LightMyRequestResponse | "timeout";
    try {
      response = await Promise.race([
        sending,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), Math.max(1, Math.floor(leaseMs * 0.8)));
        }),
      ]);
    } catch (error) {
      clearInterval(renewer);
      clearTimeout(timer);
      // injectAsDelegate refuses before it sends anything.
      if (error instanceof DelegationRefusedError && !mayHaveSent) {
        await log("refused", "not_allowed", []);
        return void (await deps.store.finish(
          operation.id,
          token,
          { status: "failed", errorCode: "not_allowed" },
          now(),
        ));
      }
      // Sent or not, nobody knows: the run stays running and is taken over with the same key.
      await log("failed", "request_failed", []);
      throw error;
    }
    clearInterval(renewer);
    clearTimeout(timer);
    if (response === "timeout") {
      // Still running somewhere: the recovery job sends the same key again later.
      await log("failed", "timeout", []);
      return;
    }

    const answer = classifyChangeAnswer(action, response.statusCode, bodyOf(response), {
      mayHaveSent,
    });
    await log(
      answer.logOutcome,
      answer.kind === "done" ? null : answer.errorCode,
      answer.kind === "done" ? recordsOf(action, operation.arguments, answer.result) : [],
    );
    // Taken over meanwhile: the new holder records and finishes.
    if (!(await record(response.statusCode))) return;
    if (answer.kind === "done") {
      await deps.store.finish(
        operation.id,
        token,
        { status: "done", result: answer.result },
        now(),
      );
    } else if (answer.kind === "refused") {
      await deps.store.finish(
        operation.id,
        token,
        { status: "failed", errorCode: answer.errorCode },
        now(),
      );
    }
    // "unknown": the run stays running; the recovery job sends the same request again.
  }

  return {
    async startAndRun(operationId) {
      const started = await deps.store.start(operationId, lease, now());
      if (!started) return null;
      if (!started.won) return started.operation;
      await runSafely(started.operation);
      return deps.store.find(operationId);
    },

    async recover(limit = 10, stopping = () => false) {
      // One at a time: a run taken over but not started would lose its lease while it waits.
      let count = 0;
      for (; count < limit && !stopping(); count++) {
        const [operation] = await deps.store.takeOverExpired(lease, now(), 1);
        if (!operation) break;
        await runSafely(operation);
      }
      return count;
    },

    expirePending: (limit = 500) => deps.store.expirePending(now(), limit),
  };
}

function bodyOf(response: LightMyRequestResponse): unknown {
  try {
    return response.json();
  } catch {
    return undefined;
  }
}

/**
 * What a route's answer means for the change. Once a request may have gone out before (a
 * take-over, or a recorded "sent" step), only a success ends the run: a refusal now says nothing
 * about the earlier request.
 */
export function classifyChangeAnswer(
  action: Pick<ChangeAction, "output">,
  status: number,
  body: unknown,
  options: { mayHaveSent: boolean },
): ChangeAnswer {
  if (status >= 200 && status < 300) {
    // Only the action's allow-list is kept and handed back.
    const output = action.output.safeParse(body);
    return { kind: "done", result: output.success ? output.data : null, logOutcome: "ok" };
  }
  const code = (body as { code?: unknown } | undefined)?.code;
  const errorCode = typeof code === "string" && ERROR_CODE.test(code) ? code : `http_${status}`;
  if (status >= 500 || status === 429 || RETRY_CODES.has(errorCode) || options.mayHaveSent) {
    return { kind: "unknown", errorCode, logOutcome: "failed" };
  }
  // The route refused a first request: the change did not happen.
  const logOutcome: AiActionOutcome =
    status === 401 || status === 403
      ? "denied"
      : status === 400 || status === 422
        ? "invalid"
        : "refused";
  return { kind: "refused", errorCode, logOutcome };
}

/** The records a change's path names, typed as the routes' own audit rows type them. */
const PATH_RECORDS: Readonly<Record<string, string>> = {
  threadId: "message_thread",
  roomUnitId: "physical_room_unit",
  blockId: "room_block",
};

/** The records a done change touched: from its path, or from its answer where the path has none. */
function recordsOf(
  action: ChangeAction,
  args: Record<string, unknown>,
  result: unknown,
): AiRecordRef[] {
  const records: AiRecordRef[] = [];
  for (const name of action.pathParamNames) {
    const type = PATH_RECORDS[name];
    const id = args[name];
    if (type && typeof id === "string") records.push({ type, id });
  }
  const answer = (result ?? {}) as {
    items?: { blockId?: unknown }[];
    note?: { noteId?: unknown };
  };
  if (records.length === 0) {
    for (const item of answer.items ?? []) {
      if (typeof item.blockId === "string") records.push({ type: "room_block", id: item.blockId });
    }
  }
  if (typeof answer.note?.noteId === "string") {
    records.push({ type: "booking_note_private", id: answer.note.noteId });
  }
  return records;
}
