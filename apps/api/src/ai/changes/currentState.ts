// What vayada reads when the AI asks for a change (VAY-2524; Flamur, 2026-11-24): the current
// version of the record the change names. The change keeps it and the route compares it, so a
// record a person changed before the Yes is refused, not overwritten; the card checks it too. The
// AI never sends it: it can't read versions, and a version from the model would decide nothing.
//
// The read is the change's own read route (its `currentState`), run as the person through the
// tool call's delegation: read only, on the delegation's properties (the read's property is checked
// against them), with the route's own rights checks. Only the version is kept; nothing of the
// answer reaches the model or the log.
import { DelegationRefusedError, type RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

import type { ChangeAction } from "../actions/defineChangeAction.js";
import { splitRouteKey } from "../actions/defineRouteAction.js";
import { runDelegatedRead } from "../delegatedRead.js";

export type CurrentState =
  | { ok: true; values: Readonly<Record<string, unknown>> }
  /** missing: the record is not there (any more); not_allowed: the person can't read it. */
  | { ok: false; reason: "missing" | "not_allowed" | "unavailable" };

export type CurrentStateReader = (
  context: RequestContext,
  action: ChangeAction,
  input: Readonly<Record<string, unknown>>,
) => Promise<CurrentState>;

/** Reads a change's preconditions through `app`, as the person of the tool call's `context`. */
export async function readCurrentState(
  app: FastifyInstance,
  context: RequestContext,
  action: ChangeAction,
  input: Readonly<Record<string, unknown>>,
): Promise<CurrentState> {
  const read = action.currentState;
  if (!read) return { ok: true, values: {} };
  const [, routeUrl] = splitRouteKey(read.route);
  // Its path parameters are the change's own (defineChangeAction checks).
  const params: Record<string, string> = {};
  for (const segment of routeUrl.split("/")) {
    if (segment.startsWith(":")) params[segment.slice(1)] = String(input[segment.slice(1)]);
  }
  let answer: Awaited<ReturnType<typeof runDelegatedRead>>;
  try {
    answer = await runDelegatedRead(app, {
      context,
      routeUrl,
      params,
      ...(read.query ? { query: read.query } : {}),
    });
  } catch (error) {
    // A property outside the delegation, or the gate: the person can't read it this way.
    if (error instanceof DelegationRefusedError) return { ok: false, reason: "not_allowed" };
    throw error;
  }
  if (answer.statusCode === 404) return { ok: false, reason: "missing" };
  if (answer.statusCode === 401 || answer.statusCode === 403) {
    return { ok: false, reason: "not_allowed" };
  }
  if (answer.statusCode !== 200) return { ok: false, reason: "unavailable" };
  let values: Readonly<Record<string, unknown>> | null;
  try {
    values = read.pick(answer.body, input);
  } catch {
    // An answer of another shape: nothing to compare with, so nothing to ask.
    return { ok: false, reason: "unavailable" };
  }
  return values ? { ok: true, values } : { ok: false, reason: "missing" };
}
