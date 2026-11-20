// One AI action generated from one next-api route (VAY-2507; decision of 2026-11-20).
//
// The route, its method and its path parameters come from the route list captured from the app
// (routeManifest.generated.ts). A person writes only what the route can not say about itself: the
// description for the AI, the output allow-list (only the fields the job needs; unknown keys are
// stripped), the permission the route really checks, the read tier and the surfaces. Phase 1 is
// read-only: only GET routes can become actions.
import type { PermissionKey } from "@vayada/backend-auth";
import { z } from "zod";

import type { RouteKey } from "../routeManifest.generated.js";

/** Read tiers: what data leaves vayada (AI actions design note §3.1). */
export type ReadTier = "R0" | "R1" | "R2-finance" | "R2";
export type AiSurface = "mcp" | "in_app";

type QueryShape = Record<string, z.ZodType>;

export type RouteActionDefinition<Output extends z.ZodType = z.ZodType> = {
  /** snake_case, e.g. "rooms_list". A changed input or output is a new version. */
  name: string;
  version: number;
  /** When to call it and what it returns. Never hotel data. */
  description: string;
  /** "GET /api/...": a route from the generated route list. */
  route: RouteKey;
  /** Query parameters the AI may send; every path parameter is added from the route. */
  query?: QueryShape;
  /** Schemas for path parameters other than propertyId and hotelId (those are UUIDs). */
  pathParams?: QueryShape;
  /** Extra input rules, e.g. a date range cap; returns a message for the AI or null. */
  check?: (input: Record<string, unknown>) => string | null;
  /** The output allow-list: only these fields leave; everything else is dropped. */
  output: Output;
  /** The permission key the route really checks (proven by the generated safety tests). */
  permission: PermissionKey;
  tier: ReadTier;
  surfaces: readonly AiSurface[];
  /** The route's contractVersion this allow-list was written against. */
  contractVersion?: string;
  /** Who reviewed the description, the allow-list and the group (plan v3.7 `source`). */
  reviewedBy: string;
};

export type RouteAction<Output extends z.ZodType = z.ZodType> = Readonly<
  RouteActionDefinition<Output> & {
    /** "rooms_list@1" */
    key: string;
    method: "GET";
    routeUrl: string;
    pathParamNames: readonly string[];
    input: z.ZodType<Record<string, unknown>>;
  }
>;

const NAME = /^[a-z][a-z0-9_]{2,63}$/;
const PROPERTY_PARAMS = new Set(["propertyId", "hotelId"]);
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export class ActionDefinitionError extends Error {
  constructor(action: string, problem: string) {
    super(`AI action ${action}: ${problem}`);
    this.name = "ActionDefinitionError";
  }
}

/** Builds an action from its route and checks every rule a definition alone can break. */
export function defineRouteAction<Output extends z.ZodType>(
  definition: RouteActionDefinition<Output>,
): RouteAction<Output> {
  const key = `${definition.name}@${definition.version}`;
  const fail = (problem: string): never => {
    throw new ActionDefinitionError(key, problem);
  };
  if (!NAME.test(definition.name)) fail("name must be snake_case");
  if (!Number.isInteger(definition.version) || definition.version < 1) fail("bad version");
  const description = definition.description.trim();
  if (description.length < 20 || description.length > 1000) fail("description length");
  if (UUID_IN_TEXT.test(description)) fail("the description must not carry ids");
  if (!definition.reviewedBy.trim()) fail("needs a reviewer");
  if (definition.surfaces.length === 0) fail("needs a surface");

  const [method, routeUrl] = splitRouteKey(definition.route);
  if (method !== "GET") fail("Phase 1 is read-only: only GET routes can become actions");

  const pathParamNames = routeUrl
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
  const shape: Record<string, z.ZodType> = {};
  for (const name of pathParamNames) {
    // Only the canonical property id has a known shape; every other parameter is declared
    // (review ids are the OTA's own ids, module and step ids are enums).
    const schema =
      definition.pathParams?.[name] ?? (PROPERTY_PARAMS.has(name) ? z.uuid() : undefined);
    if (!schema) fail(`path parameter ${name} needs a schema`);
    shape[name] = schema!;
  }
  for (const [name, schema] of Object.entries(definition.query ?? {})) {
    if (name in shape) fail(`query ${name} clashes with a path parameter`);
    shape[name] = schema;
  }
  for (const name of Object.keys(definition.pathParams ?? {})) {
    if (!pathParamNames.includes(name)) fail(`pathParams.${name} is not in the route`);
  }

  assertAllowList(definition.output, key);
  if (definition.surfaces.includes("mcp")) assertMcpSafeSlice(definition.output, key);

  const check = definition.check;
  const input = z.strictObject(shape).superRefine((value, ctx) => {
    const problem = check?.(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

  return Object.freeze({
    ...definition,
    description,
    key,
    method: "GET" as const,
    routeUrl,
    pathParamNames,
    input: input as unknown as z.ZodType<Record<string, unknown>>,
  });
}

export function splitRouteKey(route: string): [string, string] {
  const space = route.indexOf(" ");
  if (space < 1) throw new Error(`Not a route key: ${route}`);
  return [route.slice(0, space), route.slice(space + 1)];
}

type ZodDef = {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
};
const defOf = (schema: z.ZodType): ZodDef =>
  (schema as unknown as { _zod: { def: ZodDef } })._zod.def;

const LEAF_TYPES = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "null",
  "enum",
  "literal",
  "date",
  "bigint",
]);
const WRAPPER_TYPES = new Set(["optional", "nullable", "default", "readonly", "nonoptional"]);

/**
 * An output schema is an allow-list only if every value in it is spelled out: objects that drop
 * unknown keys, arrays and unions of those, and plain leaves. Anything that lets a whole unknown
 * subtree through (unknown, any, record, map, loose objects, transforms) is refused.
 */
export function assertAllowList(schema: z.ZodType, action: string, path = "output"): void {
  const def = defOf(schema);
  if (LEAF_TYPES.has(def.type)) return;
  if (WRAPPER_TYPES.has(def.type)) return assertAllowList(def.innerType!, action, path);
  if (def.type === "array") return assertAllowList(def.element!, action, `${path}[]`);
  if (def.type === "union") {
    for (const option of def.options ?? []) assertAllowList(option, action, path);
    return;
  }
  if (def.type === "object") {
    if (def.catchall && defOf(def.catchall).type !== "never") {
      throw new ActionDefinitionError(action, `${path} keeps unknown keys`);
    }
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      assertAllowList(child, action, `${path}.${key}`);
    }
    return;
  }
  throw new ActionDefinitionError(action, `${path} is a ${def.type}, not an allow-list`);
}

/** Every key path of an allow-list schema, e.g. "items[].roomNumber". */
export function allowListPaths(schema: z.ZodType, path = ""): string[] {
  const def = defOf(schema);
  if (WRAPPER_TYPES.has(def.type)) return allowListPaths(def.innerType!, path);
  if (def.type === "array") return allowListPaths(def.element!, `${path}[]`);
  if (def.type === "union") return (def.options ?? []).flatMap((o) => allowListPaths(o, path));
  if (def.type === "object") {
    return Object.entries(def.shape ?? {}).flatMap(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key;
      return [childPath, ...allowListPaths(child, childPath)];
    });
  }
  return [];
}

/**
 * Outside AI apps get no guest names, contact details or money until the owner turns them on
 * (VAY-2529; Flamur 2026-11-20). Until that opt-in exists, an MCP action may not keep a field
 * whose name says it is one. Sell prices are not money in this sense (design note §3.2).
 */
const MCP_BLOCKED_KEY =
  /guest|email|phone|contact|address|passport|document|birth|nationality|amount|balance|revenue|payment|payout|fee|commission|refund|adr\b|invoice|folio/i;

export function assertMcpSafeSlice(schema: z.ZodType, action: string): void {
  for (const path of allowListPaths(schema)) {
    const key = path.split(".").pop()!.replace("[]", "");
    if (MCP_BLOCKED_KEY.test(key)) {
      throw new ActionDefinitionError(
        action,
        `MCP may not return ${path} without the owner's opt-in`,
      );
    }
  }
}
