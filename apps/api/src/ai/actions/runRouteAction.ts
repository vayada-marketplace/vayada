// Runs one registered AI action as the signed-in user and returns only its allow-listed output
// (VAY-2507). Errors come back in one shape whatever the route answered (VAY-2567 rank 5), and
// never carry the route's own body, so nothing outside the allow-list leaves through an error.
//
// Every call writes exactly one AI action log row (VAY-2508), whatever its outcome: who, where,
// which action, the ids, dates and enum values of its input (never free text, never its output)
// and the keys that join it to the route's own audit rows.
//
// Whatever the AI sends comes back as a result. It throws only for the caller's own mistakes,
// before anything runs: a context that is not delegated, or an entry the log would refuse.
import { randomUUID } from "node:crypto";

import {
  delegatedPropertyIds,
  DelegationRefusedError,
  type RequestContext,
} from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

import {
  isLoggableUuid,
  withAiActionLog,
  type AiActionLog,
  type AiActionOutcome,
} from "../actionLog/actionLog.js";
import { argumentKindsOf } from "../actionLog/argumentKinds.js";
import { DEFAULT_PROPERTY_PARAMS, runDelegatedRead } from "../delegatedRead.js";
import type { AiSurface, RouteAction } from "./defineRouteAction.js";
import { surfaceOf } from "./registry.js";

export type ActionErrorCode =
  | "invalid_input"
  | "not_allowed"
  | "not_found"
  | "busy"
  | "unavailable"
  | "unexpected_response"
  | "failed";

export type ActionResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ActionErrorCode; message: string } };

export type RunRouteActionOptions = {
  /** Where the call's one row goes. Required: no AI action runs without its row. */
  log: AiActionLog;
  /** The outside AI app's client id (MCP) or our own feature, e.g. "in_app_assistant". */
  client: string;
  /** The provider's tool-call id or the MCP JSON-RPC id: logged, never the identity. */
  externalCallId?: string | null;
  /** provider/model/region when vayada pays for the model (in-app). */
  model?: string | null;
  /** Told when a row could not be written; defaults to the app's error log. */
  onLogFailure?: (error: unknown) => void;
  clock?: () => number;
};

/** How each answer is logged; the error code itself is logged too. */
const OUTCOME: Record<ActionErrorCode, AiActionOutcome> = {
  invalid_input: "invalid",
  not_allowed: "denied",
  not_found: "failed",
  busy: "failed",
  unavailable: "failed",
  // The route answered, but outside the allow-list: we refused to pass it on.
  unexpected_response: "refused",
  failed: "failed",
};

const failure = (code: ActionErrorCode, message: string): ActionResult => ({
  ok: false,
  error: { code, message },
});

type ParsedInput = ReturnType<RouteAction["input"]["safeParse"]>;

export async function runRouteAction(
  app: FastifyInstance,
  context: RequestContext,
  action: RouteAction,
  rawInput: unknown,
  options: RunRouteActionOptions,
): Promise<ActionResult> {
  // The surface comes from the delegation itself, so an MCP call can never run an in-app action.
  const surface = surfaceOf(context);
  if (!surface) {
    // Not an AI call: there is nobody to attribute a row to, so nothing runs.
    throw new TypeError("runRouteAction needs a delegated context");
  }
  const parsed = action.input.safeParse(rawInput ?? {});
  const propertyId = parsed.success ? propertyInScope(context, parsed.data) : null;
  // The id the route sees as its request id, so the row joins the route's own audit rows.
  const requestId = randomUUID();
  let ran = false;
  try {
    return await withAiActionLog<ActionResult>(
      options.log,
      {
        organizationId: context.selectedOrganization.organizationId,
        userId: context.actor.internalUserId,
        propertyId,
        surface,
        client: options.client,
        connectionId: loggable(context.delegation?.connectionId),
        conversationId: loggable(context.delegation?.conversationId),
        action: action.name,
        actionVersion: action.version,
        group: action.tier,
        // Invalid input is logged as sent: only declared ids, dates and enum values survive.
        arguments: parsed.success ? parsed.data : rawInput,
        argumentKinds: argumentKindsOf(action.input),
        sensitive: action.tier === "R2" || action.tier === "R2-finance",
        // What the route's own audit rows carry: this request id and the tool call's id.
        requestId,
        correlationId: context.audit.correlationId ?? null,
        externalCallId: options.externalCallId ?? null,
        model: options.model ?? null,
      },
      async () => {
        ran = true;
        let result: ActionResult;
        try {
          result = await runChecked(app, context, action, surface, parsed, requestId);
        } catch {
          result = failure("failed", "The request did not succeed.");
        }
        if (!result.ok) {
          return {
            value: result,
            outcome: OUTCOME[result.error.code],
            errorCode: result.error.code,
          };
        }
        const recordsRead = propertyId ? [{ type: "property", id: propertyId }] : [];
        return { value: result, recordsRead };
      },
      { clock: options.clock },
    );
  } catch (error) {
    // Before the action ran, the entry itself was wrong: the caller's code, never the AI's input.
    if (!ran) throw error;
    // The row could not be written, so the answer is not handed on: an AI action that is not
    // logged did not happen as far as the AI knows. The database's error text stays here.
    const report =
      options.onLogFailure ??
      ((logError: unknown) => app.log.error({ err: logError }, "AI action log row not written"));
    report(error);
    return failure("unavailable", "This is unavailable right now.");
  }
}

/** The property column: only one the member may use, so it always names a real property. */
function propertyInScope(context: RequestContext, input: Record<string, unknown>): string | null {
  const allowed = new Set(delegatedPropertyIds(context));
  for (const name of DEFAULT_PROPERTY_PARAMS) {
    const value = input[name];
    if (isLoggableUuid(value) && allowed.has(value)) return value;
  }
  return null;
}

const loggable = (id: string | undefined): string | null => (isLoggableUuid(id) ? id : null);

async function runChecked(
  app: FastifyInstance,
  context: RequestContext,
  action: RouteAction,
  surface: AiSurface,
  parsed: ParsedInput,
  requestId: string,
): Promise<ActionResult> {
  if (!action.surfaces.includes(surface)) {
    return failure("not_allowed", "This action is not available here.");
  }
  if (!parsed.success) {
    // Paths and messages only, never the values the model sent.
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
    return failure("invalid_input", issues.join("; "));
  }
  if (!context.membership.permissions.includes(action.permission)) {
    return failure("not_allowed", "You do not have access to this.");
  }

  const params: Record<string, string> = {};
  const query: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    if (action.pathParamNames.includes(name)) params[name] = String(value);
    else query[name] = value as string | number | boolean;
  }

  let response: { statusCode: number; body: unknown };
  try {
    response = await runDelegatedRead(app, {
      context,
      routeUrl: action.routeUrl,
      params,
      query,
      requestId,
    });
  } catch (error) {
    if (error instanceof DelegationRefusedError) {
      return failure("not_allowed", "You do not have access to this.");
    }
    // Never pass an error's own text on: it can carry bytes of a route's body.
    return failure("failed", "The request did not succeed.");
  }

  const { statusCode, body } = response;
  if (statusCode === 401 || statusCode === 403) {
    return failure("not_allowed", "You do not have access to this.");
  }
  if (statusCode === 404) return failure("not_found", "Not found.");
  if (statusCode === 409 || statusCode === 429) {
    return failure("busy", "Someone else is changing this right now. Try again in a moment.");
  }
  if (statusCode === 400 || statusCode === 422) {
    return failure("invalid_input", "The request was not accepted.");
  }
  if (statusCode >= 500) return failure("unavailable", "This is unavailable right now.");
  if (statusCode !== 200) return failure("failed", "The request did not succeed.");

  if (action.contractVersion !== undefined) {
    const version = (body as { contractVersion?: unknown } | null)?.contractVersion;
    if (version !== action.contractVersion) {
      return failure("unexpected_response", "The answer changed shape; the action needs review.");
    }
  }
  const output = action.output.safeParse(body);
  if (!output.success) {
    return failure("unexpected_response", "The answer changed shape; the action needs review.");
  }
  return { ok: true, data: output.data };
}
