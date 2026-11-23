// The AI action registry (VAY-2507): every action the in-app assistant and MCP can use, and the
// only routes an AI may run as a user. Registration refuses an action whose route is on the never
// list, deny-listed or not sorted for the AI, so the app does not even start with one. Change
// actions (VAY-2522) run only through the executor of AI changes, which alone can mint a delegation
// that writes (VAY-2524); until it exists they are offered on no surface.
import type { DelegatedRouteGate, RequestContext } from "@vayada/backend-auth";
import { z } from "zod";

import { neverArea } from "../neverList.js";
import { classifyRoute } from "../routeClassification.js";
import { ROUTE_MANIFEST } from "../routeManifest.generated.js";
import { bookingNoteAdd } from "./bookingNoteAdd.js";
import { calendarDays } from "./calendarDays.js";
import { isDefinedChangeAction, type ChangeAction } from "./defineChangeAction.js";
import type { AiSurface, RouteAction } from "./defineRouteAction.js";
import { propertiesList } from "./propertiesList.js";
import { roomBlockCreate, roomBlockRelease } from "./roomBlocks.js";
import { roomsList } from "./roomsList.js";
import { roomStatusSet } from "./roomStatusSet.js";
import { threadFollowUp, threadMarkDone, threadReopen } from "./threadTriage.js";

export const AI_ACTIONS: readonly RouteAction[] = assertRegistry([
  propertiesList,
  roomsList,
  calendarDays,
]);

/** The first change batch (plan row 50). */
export const CHANGE_ACTIONS: readonly ChangeAction[] = assertChangeRegistry(
  [
    bookingNoteAdd,
    roomBlockCreate,
    roomBlockRelease,
    roomStatusSet,
    threadMarkDone,
    threadFollowUp,
    threadReopen,
  ],
  AI_ACTIONS,
);

const ACTION_ROUTES = new Set<string>(
  [...AI_ACTIONS, ...CHANGE_ACTIONS].map((action) => action.route),
);
const BY_KEY = new Map(AI_ACTIONS.map((action) => [action.key, action]));
const CHANGE_BY_KEY = new Map(CHANGE_ACTIONS.map((action) => [action.key, action]));
const CHANGE_BY_ROUTE = new Map<string, ChangeAction>(
  CHANGE_ACTIONS.map((action) => [action.route, action]),
);

/**
 * The auth plugin's delegation gate: an AI may run exactly the routes of registered actions. A
 * change route also needs a delegation that may write, which only the executor mints (VAY-2522).
 */
export const aiActionRouteGate: DelegatedRouteGate = {
  allowsRoute: (method, routeUrl) => ACTION_ROUTES.has(`${method} ${routeUrl}`),
};

export function findAction(key: string): RouteAction | undefined {
  return BY_KEY.get(key);
}

export function findChangeAction(key: string): ChangeAction | undefined {
  return CHANGE_BY_KEY.get(key);
}

export type DelegatedWrite = {
  method: string;
  /** The route template Fastify matched. */
  routeUrl: string | undefined;
  params: unknown;
  query: unknown;
  body: unknown;
  /** The request's one Idempotency-Key header. */
  idempotencyKey: string | undefined;
};

/**
 * Why a delegated write is not one the AI may make, or null. The app runs this on every
 * delegated write before the route does (VAY-2522 review M1): the gate allows a route, and this
 * holds the request to its change action, so the AI never reaches the route's other fields (a
 * room's number on the room update) and every retry key belongs to the action it serves.
 */
export function delegatedWriteProblem(write: DelegatedWrite): string | null {
  const action = CHANGE_BY_ROUTE.get(`${write.method} ${write.routeUrl}`);
  if (!action) return "not the route of an AI change";
  if (!isPlainObject(write.query) || Object.keys(write.query).length > 0) {
    return "an AI change sends no query";
  }
  if (!isPlainObject(write.params) || !isPlainObject(write.body)) return "the request is malformed";
  const key = write.idempotencyKey;
  // changeRequest binds the executor's key to the action (routeIdempotencyKey).
  if (!key?.endsWith(`:${action.name}`)) return "the retry key is not this change's";
  const keyFields: readonly string[] =
    action.idempotency.in === "body" ? action.idempotency.fields : [];
  const input: Record<string, unknown> = { ...write.params };
  for (const [field, value] of Object.entries(write.body)) {
    if (keyFields.includes(field)) continue;
    if (Object.hasOwn(input, field)) return "a body field stands in for a path parameter";
    input[field] = value;
  }
  // The retry key goes only where the route reads it, and it is the request's own.
  for (const field of keyFields) {
    if (write.body[field] !== key) return "the retry key in the body is not the request's";
  }
  if (!action.input.safeParse(input).success) {
    return "the request is not what this change lets the AI send";
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

/** The surface a delegated context runs on, from its delegation (never from the caller). */
export function surfaceOf(context: RequestContext): AiSurface | undefined {
  const channel = context.delegation?.channel;
  return channel === "mcp" || channel === "in_app" ? channel : undefined;
}

/** The actions to offer this user here: only those whose route would let them in. */
export function listActionsFor(context: RequestContext): RouteAction[] {
  const surface = surfaceOf(context);
  if (!surface) return [];
  return AI_ACTIONS.filter(
    (action) =>
      action.surfaces.includes(surface) &&
      context.membership.permissions.includes(action.permission),
  );
}

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

/** One tool definition for every surface, so MCP and the in-app assistant list identical schemas. */
export function toolDefinition(action: RouteAction): ToolDefinition {
  return {
    name: action.name,
    description: action.description,
    inputSchema: z.toJSONSchema(action.input, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(action.output, { io: "output" }) as Record<string, unknown>,
  };
}

/** Throws at module load for a registry that breaks a rule the actions alone can not check. */
export function assertRegistry(actions: readonly RouteAction[]): readonly RouteAction[] {
  assertActionList(actions);
  return Object.freeze([...actions]);
}

/**
 * The same rules for change actions, read and change actions together (one name, one tool), and
 * no surface until the executor of AI changes exists (VAY-2524): nothing can offer one yet.
 */
export function assertChangeRegistry(
  actions: readonly ChangeAction[],
  readActions: readonly RouteAction[],
): readonly ChangeAction[] {
  assertActionList([...readActions, ...actions]);
  const routes = new Set<string>();
  for (const action of actions) {
    // The app holds a delegated write to the one change of its route (delegatedWriteProblem).
    if (routes.has(action.route)) throw new Error(`AI change ${action.key}: a second on its route`);
    routes.add(action.route);
    if (!isDefinedChangeAction(action)) {
      throw new Error(`AI change ${action.key} was not made by defineChangeAction`);
    }
    if (action.surfaces.length > 0) {
      throw new Error(`AI change ${action.key} has a surface before Ask first exists (VAY-2524)`);
    }
  }
  return Object.freeze([...actions]);
}

function assertActionList(actions: readonly { key: string; name: string; route: string }[]) {
  const keys = new Set<string>();
  const names = new Set<string>();
  const manifest = new Set<string>(ROUTE_MANIFEST);
  for (const action of actions) {
    if (keys.has(action.key)) throw new Error(`AI action ${action.key} is registered twice`);
    // One live version per name, so the model never sees two tools with the same name.
    if (names.has(action.name)) throw new Error(`AI action ${action.name} has two versions`);
    keys.add(action.key);
    names.add(action.name);
    if (!manifest.has(action.route)) {
      throw new Error(`AI action ${action.key}: ${action.route} is not in the route list`);
    }
    // The never list first, on its own (it can not be overridden by the classification).
    const never = neverArea(action.route);
    if (never) {
      throw new Error(
        `AI action ${action.key}: ${action.route} is on the never list (${never.area})`,
      );
    }
    // An action's route may not be sorted at all: not deny-listed, not even "later".
    const routeClass = classifyRoute(action.route);
    if (routeClass) {
      throw new Error(
        `AI action ${action.key}: ${action.route} is sorted as ${JSON.stringify(routeClass)}`,
      );
    }
  }
}
