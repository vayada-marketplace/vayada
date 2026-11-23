// How an AI asks for a change (VAY-2524): the in-app assistant's and the MCP server's tool layers
// call this with the tool call's own delegated (read) context. It never runs anything: it checks
// the change against the action and the person's rights now, and records it as one pending
// operation, which waits for the person's Yes on a vayada card (pendingActions.ts). A retried or
// regenerated call with the same arguments gets the same operation back (operationStore.ts).
//
// Every call writes one AI action log row, whatever its outcome, as reads do (runRouteAction.ts).
import { delegatedPropertyIds, type RequestContext } from "@vayada/backend-auth";

import { isLoggableUuid, type AiActionLog, type AiActionOutcome } from "../actionLog/actionLog.js";
import { argumentKindsOf } from "../actionLog/argumentKinds.js";
import type { ChangeAction } from "../actions/defineChangeAction.js";
import { findChangeAction, surfaceOf } from "../actions/registry.js";
import type { AiOperationStatus, AiOperationStore } from "../executor/operationStore.js";
import { changeArgumentProblem } from "./changeCard.js";
import { mayMakeChange } from "./pendingActions.js";

export type ProposeChangeRequest = {
  /** "room_block_create@1" */
  action: string;
  arguments: unknown;
  /** The outside AI app's client id (MCP) or vayada's own assistant, e.g. "in_app_assistant". */
  client: string;
  /** The in-app turn: a regenerated step stays in it, a new question is a new one. */
  requestScope?: string;
  /** Provider tool-call id or MCP JSON-RPC id: logged, never the identity. */
  externalCallId?: string | null;
  model?: string | null;
  /**
   * The route's own preview the Yes binds to (its digest is part of the card's), and how long it
   * holds if less than 15 minutes. From vayada's preview read, never from the model.
   */
  previewSha256?: string;
  expiresInMs?: number;
};

export type ProposeChangeError = "unknown_action" | "invalid_input" | "not_allowed";

export type ProposeChangeResult =
  | {
      ok: true;
      /** What the card (and the AI, when it checks back) knows the change by. */
      pendingActionId: string;
      /** "pending" for a new one; a retry may find it running, done or ended. */
      status: AiOperationStatus;
      expiresAt: string | null;
      created: boolean;
    }
  | { ok: false; error: { code: ProposeChangeError; message: string } };

const OUTCOME: Record<ProposeChangeError, AiActionOutcome> = {
  unknown_action: "invalid",
  invalid_input: "invalid",
  not_allowed: "denied",
};

export function createAiChangeProposer(deps: {
  store: Pick<AiOperationStore, "propose">;
  log: AiActionLog;
  /** Hands back a log row that could not be written: the proposal itself stands. */
  onLogFailure: (error: unknown) => void;
  findAction?: (key: string) => ChangeAction | undefined;
  now?: () => Date;
}) {
  const findAction = deps.findAction ?? findChangeAction;
  const now = deps.now ?? (() => new Date());

  return async function proposeChange(
    context: RequestContext,
    request: ProposeChangeRequest,
  ): Promise<ProposeChangeResult> {
    // The surface comes from the delegation itself, never from the caller.
    const surface = surfaceOf(context);
    if (!surface || !context.delegation) {
      throw new TypeError("proposeChange needs the tool call's delegated context");
    }
    // A change belongs to its MCP connection or in-app conversation (the card's "still there").
    const channelId =
      surface === "mcp" ? context.delegation.connectionId : context.delegation.conversationId;
    if (!isLoggableUuid(channelId)) {
      throw new TypeError("proposeChange needs the delegation's connection or conversation");
    }
    const started = performance.now();
    const action = findAction(request.action);
    const parsed = action?.input.safeParse(request.arguments ?? {});
    // As checked, with ids in lower case: one change asked in any letter case is one question.
    const data = action && parsed?.success ? lowerCaseIds(action, parsed.data) : undefined;
    const propertyId = data && isLoggableUuid(data.propertyId) ? data.propertyId : null;

    const log = (outcome: AiActionOutcome, errorCode: string | null, operationId: string | null) =>
      deps.log
        .record({
          organizationId: context.selectedOrganization.organizationId,
          propertyId:
            propertyId && delegatedPropertyIds(context).includes(propertyId) ? propertyId : null,
          userId: context.actor.internalUserId,
          surface,
          client: request.client,
          connectionId: loggable(context.delegation?.connectionId),
          conversationId: loggable(context.delegation?.conversationId),
          action: action?.name ?? "unknown_change",
          actionVersion: action?.version ?? 1,
          group: "ask",
          // Only declared ids, dates and enum values survive; never the free text.
          arguments: data,
          argumentKinds: action ? argumentKindsOf(action.input) : {},
          outcome,
          errorCode,
          latencyMs: performance.now() - started,
          requestId: context.delegation!.toolCallId,
          correlationId: operationId ? `op_${operationId}` : null,
          operationId,
          externalCallId: request.externalCallId ?? null,
          model: request.model ?? null,
        })
        .catch((error: unknown) => deps.onLogFailure(error));
    const refuse = async (code: ProposeChangeError, message: string) => {
      await log(OUTCOME[code], code, null);
      return { ok: false as const, error: { code, message } };
    };

    // Only changes offered here: an MCP call can never ask for an in-app-only change.
    if (!action || !action.surfaces.includes(surface)) {
      return refuse("unknown_action", "This change is not available here.");
    }
    if (!parsed?.success) {
      // Paths and messages only, never the values the model sent.
      const issues = (parsed?.error.issues ?? [])
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
      return refuse("invalid_input", issues.join("; ") || "The input is not valid.");
    }
    // What its card could never show (e.g. a last night before the first).
    const problem = changeArgumentProblem(action.key, data!);
    if (problem) return refuse("invalid_input", problem);
    if (
      !propertyId ||
      !delegatedPropertyIds(context).includes(propertyId) ||
      !mayMakeChange(context, action, propertyId)
    ) {
      return refuse("not_allowed", "You can't make this change on this property.");
    }

    let proposed: Awaited<ReturnType<typeof deps.store.propose>>;
    try {
      proposed = await deps.store.propose(
        {
          organizationId: context.selectedOrganization.organizationId,
          propertyId,
          userId: context.actor.internalUserId,
          surface,
          connectionId: context.delegation.connectionId,
          conversationId: context.delegation.conversationId,
          requestScope: request.requestScope,
          client: request.client,
          action,
          arguments: data!,
          previewSha256: request.previewSha256,
          expiresInMs: request.expiresInMs,
        },
        now(),
      );
    } catch (error) {
      // Its row too: the ask failed, and nothing was stored.
      await log("failed", "store_failed", null);
      throw error;
    }
    const { operation, created } = proposed;
    await log("ok", null, operation.id);
    return {
      ok: true,
      pendingActionId: operation.id,
      status: operation.status,
      expiresAt: operation.expiresAt,
      created,
    };
  };
}

const loggable = (id: string | undefined): string | null => (isLoggableUuid(id) ? id : null);

/** The action's id and id-list arguments in lower case, as the database writes UUIDs. */
function lowerCaseIds(
  action: Pick<ChangeAction, "input">,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const lowered = { ...args };
  for (const [key, kind] of Object.entries(argumentKindsOf(action.input))) {
    const value = lowered[key];
    if (kind === "id" && typeof value === "string") lowered[key] = value.toLowerCase();
    if (kind === "ids" && Array.isArray(value)) {
      lowered[key] = value.map((id: unknown) => (typeof id === "string" ? id.toLowerCase() : id));
    }
  }
  return lowered;
}
