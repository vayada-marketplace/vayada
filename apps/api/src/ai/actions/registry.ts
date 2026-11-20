// The AI action registry (VAY-2507): every action the in-app assistant and MCP can use, and the
// only routes an AI may run as a user. Registration refuses an action whose route is on the never
// list, deny-listed or not sorted for the AI, so the app does not even start with one.
import type { DelegatedRouteGate, RequestContext } from "@vayada/backend-auth";
import { z } from "zod";

import { classifyRoute } from "../routeClassification.js";
import { ROUTE_MANIFEST } from "../routeManifest.generated.js";
import { calendarDays } from "./calendarDays.js";
import type { AiSurface, RouteAction } from "./defineRouteAction.js";
import { propertiesList } from "./propertiesList.js";
import { roomsList } from "./roomsList.js";

export const AI_ACTIONS: readonly RouteAction[] = assertRegistry([
  propertiesList,
  roomsList,
  calendarDays,
]);

const ACTION_ROUTES = new Set<string>(AI_ACTIONS.map((action) => action.route));
const BY_KEY = new Map(AI_ACTIONS.map((action) => [action.key, action]));

/** The auth plugin's delegation gate: an AI may run exactly the routes of registered actions. */
export const aiActionRouteGate: DelegatedRouteGate = {
  allowsRoute: (method, routeUrl) => ACTION_ROUTES.has(`${method} ${routeUrl}`),
};

export function findAction(key: string): RouteAction | undefined {
  return BY_KEY.get(key);
}

/** The actions to offer this user on this surface: only those whose route would let them in. */
export function listActionsFor(context: RequestContext, surface: AiSurface): RouteAction[] {
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
    // An action's route may not be sorted at all: not never, not deny-listed, not even "later".
    const routeClass = classifyRoute(action.route);
    if (routeClass) {
      throw new Error(
        `AI action ${action.key}: ${action.route} is sorted as ${JSON.stringify(routeClass)}`,
      );
    }
  }
  return Object.freeze([...actions]);
}
