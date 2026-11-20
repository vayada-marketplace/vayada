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

/** Phase 1 is read-only: write delegation is VAY-2522. */
export type DelegatedMethod = "GET";

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
};

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
  if (input.method !== "GET") throw new DelegationRefusedError("only GET routes can be delegated");
  if (!isMintedDelegatedContext(input.context) || !isDelegatedContext(input.context)) {
    throw new DelegationRefusedError("not a context resolveDelegatedContext returned");
  }
  const age = Date.now() - Date.parse(input.context.audit.receivedAt);
  if (!(age >= 0 && age <= DELEGATED_CONTEXT_MAX_AGE_MS)) {
    throw new DelegationRefusedError("the delegated context expired; resolve it per tool call");
  }
  if (!input.url.startsWith("/") || input.url.startsWith("//")) {
    throw new DelegationRefusedError("the URL must be a path on this server");
  }
  // Boot outside the scope, so no boot hook or timer ever holds it (review L3).
  await app.ready();
  // Each request gets its own copy with its own request id: the route may change its copy, and
  // tool-call ids are not unique enough to be request ids (review M2).
  const context: RequestContext = structuredClone(input.context);
  context.audit.requestId = randomUUID();
  const nonce = randomBytes(24);
  const scope: DelegatedScope = {
    context,
    method: input.method,
    routeUrl: input.routeUrl,
    nonce,
    state: "armed",
  };
  try {
    return await new Promise<LightMyRequestResponse>((resolve, reject) => {
      storage.run(scope, () => {
        app.inject(
          {
            method: input.method,
            url: input.url,
            headers: { [NONCE_HEADER]: nonce.toString("base64url") },
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
  if (skipPathPrefixes.some((prefix) => request.url.startsWith(prefix))) {
    throw new DelegationRefusedError("path does not take user tokens");
  }
  if (!gate?.allowsRoute(request.method, routeUrl)) {
    throw new DelegationRefusedError(`route not delegable (${request.method} ${routeUrl})`);
  }
  return scope.context;
}
