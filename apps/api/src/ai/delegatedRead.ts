// Runs one existing next-api GET route as the signed-in user, for an AI action (VAY-2506).
//
// The route's own permission, entitlement and property checks decide, exactly as for the website.
// Before that, this runner refuses any property the member may not use, so the refusal is early
// and plain. The routes refuse it too: the shared link check checks the member's assigned
// properties (VAY-2574), and the delegated context is narrowed to the member's properties.
import {
  delegatedPropertyIds,
  DelegationRefusedError,
  injectAsDelegate,
  type RequestContext,
} from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

/** Path parameters that carry a canonical property id (Booking Admin `:hotelId` takes it too). */
export const DEFAULT_PROPERTY_PARAMS = ["propertyId", "hotelId"] as const;

type QueryValue = string | number | boolean;

export type DelegatedReadRequest = {
  /** From resolveDelegatedContext, once per tool call. */
  context: RequestContext;
  /** Route template as Fastify registered it, e.g. "/api/pms/properties/:propertyId/rooms". */
  routeUrl: string;
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, QueryValue | readonly QueryValue[] | undefined>>;
  /** Path parameters that hold a property id; defaults to DEFAULT_PROPERTY_PARAMS. */
  propertyParams?: readonly string[];
};

export type DelegatedReadResult = {
  statusCode: number;
  /** Parsed JSON when the route answered JSON, else the raw text. */
  body: unknown;
};

/**
 * Runs `GET routeUrl` as the delegated user. Throws DelegationRefusedError when the delegation is
 * refused, whether before the route (property scope, template) or by the auth hook (gate, reuse,
 * expiry); a 401/403 the route itself answers comes back as its result.
 */
export async function runDelegatedRead(
  app: FastifyInstance,
  request: DelegatedReadRequest,
): Promise<DelegatedReadResult> {
  const params = request.params ?? {};
  const path = fillRouteTemplate(request.routeUrl, params);

  // Property ids in the path or the query string (e.g. /api/hotel-setup/status?propertyId=).
  const allowed = new Set(delegatedPropertyIds(request.context));
  for (const name of request.propertyParams ?? DEFAULT_PROPERTY_PARAMS) {
    const values = [params[name], request.query?.[name]].flat();
    for (const value of values) {
      if (value !== undefined && !allowed.has(String(value))) {
        throw new DelegationRefusedError("property not in the member's scope");
      }
    }
  }

  const response = await injectAsDelegate(app, {
    context: request.context,
    method: "GET",
    routeUrl: request.routeUrl,
    url: path + queryString(request.query),
  });
  const isJson = /^application\/json\b/i.test(String(response.headers["content-type"] ?? ""));
  let body: unknown = response.body;
  if (isJson && response.body) {
    try {
      body = response.json();
    } catch {
      body = undefined; // malformed JSON: never hand its bytes on
    }
  }
  // Only the auth hook answers with this code: a refused delegation, not the route's own answer.
  if (
    response.statusCode === 403 &&
    (body as { code?: unknown } | null)?.code === "delegation_refused"
  ) {
    throw new DelegationRefusedError(
      String((body as { message?: unknown }).message ?? "refused by the auth hook"),
    );
  }
  return { statusCode: response.statusCode, body };
}

/** Fills `:name` segments; refuses missing, empty, extra or wildcard parameters. */
export function fillRouteTemplate(
  routeUrl: string,
  params: Readonly<Record<string, string>>,
): string {
  if (!routeUrl.startsWith("/") || routeUrl.includes("*") || routeUrl.includes("?")) {
    throw new DelegationRefusedError("unsupported route template");
  }
  const used = new Set<string>();
  const path = routeUrl
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      const value = params[name];
      if (typeof value !== "string" || value === "") {
        throw new DelegationRefusedError(`missing route parameter ${name}`);
      }
      used.add(name);
      return encodeURIComponent(value);
    })
    .join("/");
  const extra = Object.keys(params).filter((name) => !used.has(name));
  if (extra.length) throw new DelegationRefusedError(`unknown route parameter ${extra[0]}`);
  return path;
}

function queryString(query: DelegatedReadRequest["query"]): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(name, String(item));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
