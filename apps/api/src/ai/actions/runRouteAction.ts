// Runs one registered AI action as the signed-in user and returns only its allow-listed output
// (VAY-2507). Errors come back in one shape whatever the route answered (VAY-2567 rank 5), and
// never carry the route's own body, so nothing outside the allow-list leaves through an error.
import { DelegationRefusedError, type RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

import { runDelegatedRead } from "../delegatedRead.js";
import type { AiSurface, RouteAction } from "./defineRouteAction.js";

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

const failure = (code: ActionErrorCode, message: string): ActionResult => ({
  ok: false,
  error: { code, message },
});

export async function runRouteAction(
  app: FastifyInstance,
  context: RequestContext,
  action: RouteAction,
  rawInput: unknown,
  surface: AiSurface,
): Promise<ActionResult> {
  if (!action.surfaces.includes(surface)) {
    return failure("not_allowed", "This action is not available here.");
  }
  const parsed = action.input.safeParse(rawInput ?? {});
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
    });
  } catch (error) {
    if (error instanceof DelegationRefusedError) {
      return failure("not_allowed", "You do not have access to this.");
    }
    throw error;
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
