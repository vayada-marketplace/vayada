// One AI change made from one next-api write route (VAY-2522). As for a read action, the route,
// its method and its path parameters come from the captured route list. A person writes what the
// route can not say about itself: the body the AI may send, where the route takes its retry key,
// which body fields make a change made in the meantime fail instead of being overwritten (and
// where vayada reads them: the AI never sends them), and every rights check the change passes
// through inside its transaction. Every AI change asks first
// until Undo exists (plan row 39), and only the one executor of AI changes runs one (VAY-2524).
import type { PermissionKey } from "@vayada/backend-auth";
import { z } from "zod";

import { fillRouteTemplate } from "../delegatedRead.js";
import type { RouteKey } from "../routeManifest.generated.js";
import { AUTHORITY_SITES, type AuthoritySite } from "./authoritySites.js";
import {
  assertAllowList,
  assertMcpSafeSlice,
  checkActionBasics,
  pathParamsShape,
  splitRouteKey,
  type AiSurface,
  type QueryShape,
} from "./defineRouteAction.js";

export type ChangeMethod = "POST" | "PUT" | "PATCH" | "DELETE";
const CHANGE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Where the route reads its retry key. The executor fills it (operation id and step); the AI
 * never does. */
export type ChangeIdempotency =
  | { in: "header" }
  /** Body fields the route reads the key from; the AI never sends them. */
  | { in: "body"; fields: readonly string[] };

export type ChangeActionDefinition<Output extends z.ZodType = z.ZodType> = {
  /** snake_case, e.g. "thread_mark_done". A changed input or output is a new version. */
  name: string;
  version: number;
  /** When to call it and what it changes. Never hotel data. */
  description: string;
  /** "POST /api/...": a write route from the generated route list, on one property. */
  route: RouteKey;
  /** Schemas for path parameters other than propertyId and hotelId (those are UUIDs). */
  pathParams?: QueryShape;
  /**
   * What the change puts in the body: the AI's fields and the preconditions, which vayada fills
   * in. The route may take more; the change reaches only this.
   */
  body: z.ZodObject;
  idempotency: ChangeIdempotency;
  /**
   * Body fields the route compares with the current state (expected versions), so a change a
   * person made in the meantime is refused, not overwritten. The AI never sends them: vayada reads
   * them from `currentState` when the AI asks (VAY-2524, Flamur 2026-11-24), and the change keeps
   * them. Empty only with `addsNew`.
   */
  preconditions: readonly string[];
  /** Where vayada reads the preconditions when the AI asks: needed with them, and only then. */
  currentState?: ChangeCurrentState;
  /** The change only adds something new (a note, a block), so it has no state to compare. */
  addsNew?: true;
  /** Every rights check inside the transaction (AUTHORITY_SITES); [] if the route's is the only one. */
  authoritySites: readonly AuthoritySite[];
  /** Every AI change asks first until Undo exists (plan row 39). */
  group: "ask";
  /** The permission key the route checks (proven by the generated change tests). */
  permission: PermissionKey;
  /** Other keys the route also checks (proven the same way), so nothing offers it to a user the
   * route refuses. */
  alsoNeeds?: readonly PermissionKey[];
  /** The allow-list of the route's answer the AI gets back. */
  output: Output;
  /** Empty until the executor of AI changes and its surfaces exist (the registry checks). */
  surfaces: readonly AiSurface[];
  /** The route's contractVersion this was written against. */
  contractVersion?: string;
  reviewedBy: string;
  /** MCP only, as for read actions: reviewed paths whose name looks sensitive. */
  mcpReviewedFields?: Readonly<Record<string, string>>;
};

/**
 * One read route of the change's property whose answer holds the preconditions' current values.
 * vayada runs it as the person, through the tool call's own delegation (read only, on its
 * properties), when the AI asks for the change; its answer never reaches the model.
 */
export type ChangeCurrentState = {
  /** "GET /api/...": its path parameters are the change's own, propertyId among them. */
  route: RouteKey;
  query?: Readonly<Record<string, string | number>>;
  /**
   * The preconditions' values in the route's answer, for the record the change names; null when
   * the record is not in it. Every precondition, and nothing else.
   */
  pick(
    answer: unknown,
    input: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> | null;
};

export type ChangeAction<Output extends z.ZodType = z.ZodType> = Readonly<
  ChangeActionDefinition<Output> & {
    /** "thread_mark_done@1" */
    key: string;
    method: ChangeMethod;
    routeUrl: string;
    pathParamNames: readonly string[];
    bodyFields: readonly string[];
    /** Path parameters and body fields without the preconditions: what the AI sends. */
    input: z.ZodType<Record<string, unknown>>;
    /** The AI's input with the preconditions vayada filled in: what the change keeps and sends. */
    requestInput: z.ZodType<Record<string, unknown>>;
  }
>;

type ZodObjectDef = {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  checks?: readonly unknown[];
};
/** Names the executor sets (retry keys) or that could reach an object's prototype. */
const RESERVED_FIELDS = new Set([
  "commandId",
  "idempotencyKey",
  "__proto__",
  "constructor",
  "prototype",
]);
/** Only change actions this module built may be registered (VAY-2522 review). */
const defined = new WeakSet<object>();

export function isDefinedChangeAction(action: object): boolean {
  return defined.has(action);
}
const defOf = (schema: z.ZodType): ZodObjectDef =>
  (schema as unknown as { _zod: { def: ZodObjectDef } })._zod.def;

/** Builds a change action from its route and checks every rule a definition alone can break. */
export function defineChangeAction<Output extends z.ZodType>(
  definition: ChangeActionDefinition<Output>,
): ChangeAction<Output> {
  const { key, fail, description } = checkActionBasics(definition);

  const [method, routeUrl] = splitRouteKey(definition.route);
  if (!CHANGE_METHODS.has(method)) fail("a change action needs a write route");
  for (const name of ["propertyId", "hotelId"]) {
    if (definition.pathParams && Object.hasOwn(definition.pathParams, name)) {
      fail(`${name} is always a UUID; it can't be redefined`);
    }
  }
  const { pathParamNames, shape } = pathParamsShape(routeUrl, definition.pathParams, fail);
  // Account-wide writes would escape a delegation narrowed to some properties (VAY-2522).
  if (!pathParamNames.includes("propertyId")) fail("a change works on one property (:propertyId)");

  // The AI's input is one strict object of path parameters and body fields; inside the body,
  // every value is spelled out (no unknown, record, loose object or transform).
  const body = defOf(definition.body);
  if (body.type !== "object") fail("the body must be an object");
  // The input is rebuilt from the fields alone, so a rule on the whole body would be lost.
  if (body.checks?.length) fail("the body may have no rule across its fields");
  assertAllowList(definition.body, key, "body");
  const bodyFields = Object.keys(body.shape ?? {});
  for (const field of bodyFields) {
    if (RESERVED_FIELDS.has(field)) fail(`the AI may not send ${field}`);
    if (Object.hasOwn(shape, field)) fail(`body field ${field} clashes with a path parameter`);
  }

  const idempotency = definition.idempotency;
  if (idempotency.in === "body") {
    if (idempotency.fields.length === 0) fail("a body retry key needs its fields");
    for (const field of idempotency.fields) {
      if (bodyFields.includes(field)) fail(`the AI may not send the retry key field ${field}`);
    }
  } else if (idempotency.in !== "header") {
    fail("unknown retry key place");
  }

  for (const field of definition.preconditions) {
    if (!bodyFields.includes(field)) fail(`precondition ${field} is not a body field`);
  }
  if (new Set(definition.preconditions).size !== definition.preconditions.length) {
    fail("a precondition is listed twice");
  }
  // A change to something that exists must refuse a state it did not see; only "adds new" has
  // nothing to compare.
  if ((definition.preconditions.length === 0) !== (definition.addsNew === true)) {
    fail("preconditions are needed unless, and only unless, it adds something new");
  }
  if (definition.addsNew && method !== "POST") fail("only a POST adds something new");
  // vayada reads them; the AI never sends them (VAY-2524).
  const current = definition.currentState;
  if (definition.preconditions.length > 0 !== Boolean(current)) {
    fail("preconditions need the read vayada takes them from, and only they do");
  }
  if (current) {
    const [readMethod, readUrl] = splitRouteKey(current.route);
    if (readMethod !== "GET") fail("vayada reads the preconditions with a GET route");
    const readParams = readUrl
      .split("/")
      .filter((segment) => segment.startsWith(":"))
      .map((segment) => segment.slice(1));
    if (!readParams.includes("propertyId")) fail("the preconditions' read is on the property");
    for (const name of readParams) {
      if (!pathParamNames.includes(name)) fail(`the preconditions' read takes :${name}`);
    }
    if (typeof current.pick !== "function") fail("the preconditions' read needs pick");
  }
  const requestShape: Record<string, z.ZodType> = { ...shape };
  for (const field of bodyFields) {
    requestShape[field] = body.shape![field]!;
    if (!definition.preconditions.includes(field)) shape[field] = body.shape![field]!;
  }

  const sites = new Set<string>();
  for (const site of definition.authoritySites) {
    const known = Object.hasOwn(AUTHORITY_SITES, site)
      ? (AUTHORITY_SITES[site as AuthoritySite] as { threaded: boolean })
      : undefined;
    if (!known) fail(`unknown rights check ${site}`);
    if (!known!.threaded) fail(`${site} does not take the AI's limits yet`);
    if (sites.has(site)) fail(`${site} is listed twice`);
    sites.add(site);
  }
  if (definition.group !== "ask") fail("every AI change asks first until Undo exists");

  assertAllowList(definition.output, key);
  if (definition.surfaces.includes("mcp")) {
    assertMcpSafeSlice(definition.output, key, definition.mcpReviewedFields ?? {});
  }

  const action = Object.freeze({
    ...definition,
    description,
    key,
    method: method as ChangeMethod,
    routeUrl,
    pathParamNames,
    bodyFields,
    input: z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>,
    requestInput: z.strictObject(requestShape) as unknown as z.ZodType<Record<string, unknown>>,
  });
  defined.add(action);
  return action;
}

/** Ids as the database compares them: a UUID in any letter case is one record. */
export const sameRecordId = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The retry key the route sees: the executor's key (operation id and step) bound to the action,
 * so one key can never serve two different changes (VAY-2522 review L3).
 */
export function routeIdempotencyKey(action: Pick<ChangeAction, "name">, key: string): string {
  return `${key}:${action.name}`;
}

export type ChangeRequest = {
  method: ChangeMethod;
  routeUrl: string;
  url: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
};

/**
 * The one request a change makes, from its stored input (the AI's, with the preconditions vayada
 * filled in) and the retry key the executor gives it (VAY-2524). The input is checked here; the
 * retry key goes where the route reads it.
 */
export function changeRequest(
  action: ChangeAction,
  args: unknown,
  idempotencyKey: string,
): { ok: true; request: ChangeRequest } | { ok: false; message: string } {
  const parsed = action.requestInput.safeParse(args);
  if (!parsed.success) {
    // Paths and messages only, never the values the model sent (as for reads).
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
    return { ok: false, message: issues.join("; ") };
  }
  const params: Record<string, string> = {};
  for (const name of action.pathParamNames) params[name] = String(parsed.data[name]);
  const body: Record<string, unknown> = {};
  for (const field of action.bodyFields) {
    if (parsed.data[field] !== undefined) body[field] = parsed.data[field];
  }
  const routeKey = routeIdempotencyKey(action, idempotencyKey);
  if (action.idempotency.in === "body") {
    for (const field of action.idempotency.fields) body[field] = routeKey;
  }
  return {
    ok: true,
    request: {
      method: action.method,
      routeUrl: action.routeUrl,
      url: fillRouteTemplate(action.routeUrl, params),
      body,
      idempotencyKey: routeKey,
    },
  };
}
