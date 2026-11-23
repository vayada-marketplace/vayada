// A one-shot scope that carries an AI action's delegated RequestContext into the auth hook of ONE
// in-process `app.inject()` request (VAY-2506; mechanism proven in the VAY-2500 spike).
//
// No header, token or handle carries the identity: only this module's AsyncLocalStorage store,
// which an outside request can never set. The store is not exported; only the auth plugin reads it
// through `takeDelegatedContext`.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";

import {
  DELEGATED_CONTEXT_MAX_AGE_MS,
  isDelegatedContext,
  isMintedDelegatedContext,
} from "./delegatedContext.js";
import { DelegationRefusedError } from "./errors.js";
import type { RequestContext } from "./types.js";

type ScopeState = "armed" | "consumed" | "closed";

type DelegatedScope = {
  readonly context: RequestContext;
  readonly method: DelegatedMethod;
  readonly routeUrl: string;
  /** Sent only on the injected request: binds the scope to that one request, not to whatever
   * request a callback-style hook might resume inside the async context (review M3). */
  readonly nonce: Buffer;
  state: ScopeState;
};

const NONCE_HEADER = "x-vayada-delegation-nonce";

/** GET runs on any delegation; a write only on a "change" one (VAY-2522). */
export type DelegatedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** What the routes accept (1-200 characters) narrowed to what the AI action log keeps. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
/** A change's JSON body; no route an AI action calls takes more. */
export const DELEGATED_BODY_MAX_BYTES = 64 * 1024;

/**
 * Which routes may run under a delegated scope. The auth plugin asks it for every delegated
 * request; without one, every delegated request is refused.
 */
export type DelegatedRouteGate = {
  allowsRoute(method: string, routeUrl: string): boolean;
};

export type DelegatedInject = {
  context: RequestContext;
  method: DelegatedMethod;
  /** Route template as Fastify registered it, e.g. "/api/pms/properties/:propertyId/rooms". */
  routeUrl: string;
  /** Concrete URL to inject, e.g. "/api/pms/properties/<uuid>/rooms?from=2026-11-20". */
  url: string;
  /** Writes only: the JSON body, a plain object or array. */
  body?: unknown;
  /**
   * Writes only, and required for them: sent as the request's one Idempotency-Key header (VAY-2524
   * sends operation id + step). Only routes that read that header use it; a route that takes its
   * key from the body, or has none, is made retry-safe by its action (VAY-2524, VAY-2523).
   */
  idempotencyKey?: string;
  /**
   * The request id the route sees: a fresh UUID for this one request. The AI action runner mints
   * it, so its log row and the route's own audit rows carry the same id (VAY-2508). Without it,
   * a new one is made here.
   */
  requestId?: string;
};

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const storage = new AsyncLocalStorage<DelegatedScope>();

/**
 * Runs one `app.inject()` as the delegated user and returns the route's response.
 *
 * The request is started in callback form inside `storage.run()`: `app.inject(opts)` without a
 * callback returns light-my-request's lazy Chain, which only starts on its first `.then()`. With
 * `await` outside `run()` that happens after the scope ended, so the auth hook would never see the
 * store (VAY-2500 finding; it fails closed with 401).
 */
export async function injectAsDelegate(
  app: FastifyInstance,
  input: DelegatedInject,
): Promise<LightMyRequestResponse> {
  if (storage.getStore()) throw new DelegationRefusedError("nested delegated request");
  // Every field is read exactly once: a getter or Proxy input can never swap what was checked for
  // what is sent (VAY-2522 review M1).
  const { context: checked, method, routeUrl, url, body, idempotencyKey, requestId } = input;
  if (typeof method !== "string" || !METHODS.has(method)) {
    throw new DelegationRefusedError("unsupported method");
  }
  if (!isMintedDelegatedContext(checked) || !isDelegatedContext(checked)) {
    throw new DelegationRefusedError("not a context resolveDelegatedContext returned");
  }
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (method === "GET") {
    if (body !== undefined || idempotencyKey !== undefined) {
      throw new DelegationRefusedError("a read sends no body and no Idempotency-Key");
    }
  } else {
    if (checked.delegation?.access !== "change") {
      throw new DelegationRefusedError("this delegation may only read");
    }
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new DelegationRefusedError("a change needs a valid Idempotency-Key");
    }
    headers["idempotency-key"] = idempotencyKey;
    if (body !== undefined) {
      payload = jsonBody(body);
      headers["content-type"] = "application/json";
    }
  }
  const age = Date.now() - Date.parse(checked.audit.receivedAt);
  if (!(age >= 0 && age <= DELEGATED_CONTEXT_MAX_AGE_MS)) {
    throw new DelegationRefusedError("the delegated context expired; resolve it per tool call");
  }
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) {
    throw new DelegationRefusedError("the URL must be a path on this server");
  }
  if (requestId !== undefined && !REQUEST_ID.test(requestId)) {
    throw new DelegationRefusedError("a request id must be a UUID");
  }
  // Boot outside the scope, so no boot hook or timer ever holds it (review L3).
  await app.ready();
  // Each request gets its own copy with its own request id: the route may change its copy, and
  // tool-call ids are not unique enough to be request ids (review M2).
  const context: RequestContext = structuredClone(checked);
  context.audit.requestId = requestId ?? randomUUID();
  const nonce = randomBytes(24);
  const scope: DelegatedScope = { context, method, routeUrl, nonce, state: "armed" };
  try {
    return await new Promise<LightMyRequestResponse>((resolve, reject) => {
      storage.run(scope, () => {
        app.inject(
          {
            method,
            url,
            headers: { ...headers, [NONCE_HEADER]: nonce.toString("base64url") },
            ...(payload === undefined ? {} : { payload }),
          },
          (error, response) =>
            error || !response ? reject(error ?? new Error("No response")) : resolve(response),
        );
      });
    });
  } finally {
    // Anything that still holds the store after this point (timers, unawaited promises, pooled
    // sockets) sees a closed scope and is refused.
    scope.state = "closed";
  }
}

/** A change's body: a plain JSON object or array, at most DELEGATED_BODY_MAX_BYTES (UTF-8). */
function jsonBody(body: unknown): string {
  const plain =
    Array.isArray(body) ||
    (typeof body === "object" && body !== null && Object.getPrototypeOf(body) === Object.prototype);
  let text: string | undefined;
  try {
    text = plain ? JSON.stringify(body) : undefined;
  } catch {
    text = undefined; // cycles and BigInts
  }
  if (typeof text !== "string") {
    throw new DelegationRefusedError("the body must be a JSON object or array");
  }
  if (Buffer.byteLength(text) > DELEGATED_BODY_MAX_BYTES) {
    throw new DelegationRefusedError("the body is too large");
  }
  return text;
}

/**
 * Called by the auth hook. Returns null when there is no delegated scope (the normal bearer
 * path). Consumes the scope exactly once and throws DelegationRefusedError for a second use, a
 * closed scope, a bearer token, a skipped path, or a route the action did not declare or the gate
 * does not allow.
 */
export function takeDelegatedContext(
  request: FastifyRequest,
  gate: DelegatedRouteGate | undefined,
  skipPathPrefixes: readonly string[] = [],
): RequestContext | null {
  const scope = storage.getStore();
  if (!scope) return null;
  if (scope.state === "consumed") throw new DelegationRefusedError("scope already used");
  if (scope.state === "closed") throw new DelegationRefusedError("scope closed");
  scope.state = "consumed";
  const sent = request.headers[NONCE_HEADER];
  delete request.headers[NONCE_HEADER];
  const nonce = typeof sent === "string" ? Buffer.from(sent, "base64url") : Buffer.alloc(0);
  if (nonce.length !== scope.nonce.length || !timingSafeEqual(nonce, scope.nonce)) {
    throw new DelegationRefusedError("not the request this scope was opened for");
  }
  if (request.headers.authorization !== undefined) {
    throw new DelegationRefusedError("bearer token on a delegated request");
  }
  const routeUrl = request.routeOptions.url;
  if (request.method !== scope.method || routeUrl === undefined || routeUrl !== scope.routeUrl) {
    throw new DelegationRefusedError(
      `route mismatch (${request.method} ${routeUrl ?? "<no route>"})`,
    );
  }
  // injectAsDelegate checks both already; the hook checks again so no other path can (VAY-2522).
  if (!isDelegatedContext(scope.context))
    throw new DelegationRefusedError("not a delegated context");
  if (request.method !== "GET" && scope.context.delegation?.access !== "change") {
    throw new DelegationRefusedError("this delegation may only read");
  }
  if (skipPathPrefixes.some((prefix) => request.url.startsWith(prefix))) {
    throw new DelegationRefusedError("path does not take user tokens");
  }
  if (!gate?.allowsRoute(request.method, routeUrl)) {
    throw new DelegationRefusedError(`route not delegable (${request.method} ${routeUrl})`);
  }
  return scope.context;
}
