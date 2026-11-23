// The one executor of AI changes (VAY-2524; design note §4.6). It runs an operation's request as
// the user who asked, with a delegation that may write and only on the operation's property,
// under the operation's lease, and records how it ended. Each step's key is bound to the operation
// (`op_<id>:<step>`, then to the action), so a double click, a take-over after a crash or a resumed
// run sends the same key and the route answers its stored result instead of changing twice.
//
// Only this module mints a delegation that writes (resolveDelegatedChangeContext; a boundary test
// keeps it here). The model, the AI SDK, Mastra and the browser never run a change: they create
// an operation or answer it.
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

import type { AiActionLog, AiActionOutcome } from "../actionLog/actionLog.js";
import { argumentKindsOf } from "../actionLog/argumentKinds.js";
import { changeRequest, type ChangeAction } from "../actions/defineChangeAction.js";
import { findChangeAction } from "../actions/registry.js";
import type { AiOperation, AiOperationStore } from "./operationStore.js";

/** How long a run holds its operation; it is renewed before every step. */
export const EXECUTOR_LEASE_MS = 60_000;
/** Answers that say the same request is still running somewhere: the outcome is not known yet. */
const IN_PROGRESS = new Set(["idempotency_conflict", "command_in_progress"]);
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export type AiChangeExecutor = {
  /**
   * The person's Yes: starts the pending change for exactly one caller and runs it. Every other
   * caller (a double click, a second tab) gets the operation as it is and joins that run. Null for
   * an unknown operation.
   */
  startAndRun(operationId: string): Promise<AiOperation | null>;
  /** The recovery job: takes over runs whose lease ran out and runs them again with the same keys. */
  recover(limit?: number): Promise<number>;
  /** Closes pending changes nobody answered in time. */
  expirePending(limit?: number): Promise<number>;
};

export function createAiChangeExecutor(deps: {
  app: FastifyInstance;
  store: AiOperationStore;
  identity: IdentityRepository;
  authorizationResolver: AuthorizationResolver;
  log: AiActionLog;
  /** This API task, as leases name it (a token is made from it at every start and take-over). */
  holder: string;
  leaseMs?: number;
  now?: () => Date;
  /** Hands back a log row that could not be written: the change itself stands. */
  onLogFailure?: (error: unknown) => void;
  /** Hands back a run that broke; it stays running and the recovery job takes it over. */
  onRunFailure?: (error: unknown, operation: AiOperation) => void;
}): AiChangeExecutor {
  const leaseMs = deps.leaseMs ?? EXECUTOR_LEASE_MS;
  const now = deps.now ?? (() => new Date());
  const lease = { holder: deps.holder, ms: leaseMs };

  const runSafely = async (operation: AiOperation) => {
    try {
      await run(operation);
    } catch (error) {
      deps.onRunFailure?.(error, operation);
    }
  };

  /** Runs an operation this caller holds the lease of (`leaseOwner`). */
  async function run(operation: AiOperation): Promise<void> {
    const token = operation.leaseOwner;
    if (!token) throw new Error("AI change run without its lease");
    const fail = (errorCode: string) =>
      deps.store.finish(operation.id, token, { status: "failed", errorCode }, now());
    const action = findChangeAction(`${operation.action}@${operation.actionVersion}`);
    if (!action) return void (await fail("unknown_action"));
    if (!(await deps.store.renewLease(operation.id, token, leaseMs, now()))) return;

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
        { authorizationResolver: deps.authorizationResolver, now },
      );
    } catch (error) {
      // The user, the account or the membership is gone or no longer active: nothing was sent.
      if (error instanceof AuthError || error instanceof DelegationRefusedError) {
        return void (await fail("not_allowed"));
      }
      throw error;
    }

    const step = 1;
    const built = changeRequest(action, operation.arguments, `op_${operation.id}:${step}`);
    if (!built.ok) return void (await fail("invalid_input"));
    const requestId = randomUUID();
    const started = performance.now();
    const record = (outcome: AiActionOutcome, errorCode: string | null) =>
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
          outcome,
          errorCode,
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
          requestId,
          correlationId: `op_${operation.id}`,
          idempotencyKey: built.request.idempotencyKey,
          operationId: operation.id,
        })
        .catch((error: unknown) => deps.onLogFailure?.(error));

    let response: LightMyRequestResponse;
    try {
      response = await injectAsDelegate(deps.app, {
        context,
        ...built.request,
        requestId,
      });
    } catch (error) {
      // injectAsDelegate refuses before it sends anything.
      if (error instanceof DelegationRefusedError) {
        await record("refused", "not_allowed");
        return void (await fail("not_allowed"));
      }
      // Sent or not, nobody knows: the run stays running and is taken over with the same key.
      await record("failed", "request_failed");
      throw error;
    }

    const recorded = await deps.store.recordStep(operation.id, token, {
      step,
      requestId,
      idempotencyKeySha256: createHash("sha256").update(built.request.idempotencyKey).digest("hex"),
      statusCode: response.statusCode,
      at: now().toISOString(),
    });
    const answer = classify(action, response);
    await record(answer.logOutcome, answer.kind === "done" ? null : answer.errorCode);
    // Taken over meanwhile: the new holder records and finishes.
    if (!recorded) return;
    if (answer.kind === "done") {
      await deps.store.finish(
        operation.id,
        token,
        { status: "done", result: answer.result },
        now(),
      );
    } else if (answer.kind === "refused") {
      await fail(answer.errorCode);
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

    async recover(limit = 10) {
      const taken = await deps.store.takeOverExpired(lease, now(), limit);
      for (const operation of taken) await runSafely(operation);
      return taken.length;
    },

    expirePending: (limit = 500) => deps.store.expirePending(now(), limit),
  };
}

type Answer =
  | { kind: "done"; result: unknown; logOutcome: AiActionOutcome }
  | { kind: "refused" | "unknown"; errorCode: string; logOutcome: AiActionOutcome };

/** What the route's answer means for the change. */
function classify(action: ChangeAction, response: LightMyRequestResponse): Answer {
  let body: unknown;
  try {
    body = response.json();
  } catch {
    body = undefined;
  }
  const status = response.statusCode;
  if (status >= 200 && status < 300) {
    // Only the action's allow-list is kept and handed back.
    const output = action.output.safeParse(body);
    return { kind: "done", result: output.success ? output.data : null, logOutcome: "ok" };
  }
  const code = (body as { code?: unknown } | undefined)?.code;
  const errorCode = typeof code === "string" && ERROR_CODE.test(code) ? code : `http_${status}`;
  if (status >= 500 || (status === 409 && IN_PROGRESS.has(errorCode))) {
    return { kind: "unknown", errorCode, logOutcome: "failed" };
  }
  // The route refused: the change did not happen.
  const logOutcome: AiActionOutcome =
    status === 401 || status === 403
      ? "denied"
      : status === 400 || status === 422
        ? "invalid"
        : "refused";
  return { kind: "refused", errorCode, logOutcome };
}
