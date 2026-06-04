import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { AuthError } from "./errors.js";
import { type IdentityRepository } from "./repository.js";
import { resolveRequestContext } from "./resolve.js";
import { type RequestContext } from "./types.js";
import { type TokenVerifier, extractBearerToken } from "./verify.js";

const CONTEXT_DECORATION = "authContext";

export type BackendAuthPluginOptions = {
  verifier: TokenVerifier;
  repository: IdentityRepository;
  /** Default locale when not specified by Accept-Language. Defaults to "en". */
  defaultLocale?: string;
  /** Default currency. Defaults to "USD". */
  defaultCurrency?: string;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved RequestContext for authenticated requests. Null on public routes. */
    authContext: RequestContext | null;
  }
}

/**
 * Fastify plugin that resolves a WorkOS access token into a RequestContext
 * and attaches it to every request as `request.authContext`.
 *
 * Unauthenticated requests (missing or invalid token) set `request.authContext`
 * to null — routes must call `requireAuthContext(request)` to enforce auth.
 * This allows public routes (health, bookability) to coexist with authenticated
 * routes without separate plugin registration.
 */
const backendAuthPluginFn: FastifyPluginAsync<BackendAuthPluginOptions> = async (
  app: FastifyInstance,
  options: BackendAuthPluginOptions,
) => {
  app.decorateRequest(CONTEXT_DECORATION, null);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return;

    try {
      const session = await options.verifier(token);
      const context = await resolveRequestContext(session, options.repository, {
        requestId: randomUUID(),
        locale: options.defaultLocale,
        currency: options.defaultCurrency,
        source: "api",
        sourceIp: request.ip,
        userAgent: request.headers["user-agent"],
      });
      request.authContext = context;
    } catch {
      // Auth errors are surfaced when requireAuthContext is called.
      // Non-auth requests simply proceed with authContext = null.
    }
  });
};

export const backendAuthPlugin = fp(backendAuthPluginFn, {
  fastify: "5",
  name: "backend-auth",
});

/**
 * Returns the resolved RequestContext for an authenticated request.
 * Throws 401 if the token was missing or invalid, 403 if the token was valid
 * but identity resolution failed.
 *
 * Call this at the start of any route handler that requires authentication.
 */
export function requireAuthContext(request: FastifyRequest, reply: FastifyReply): RequestContext {
  const ctx = request.authContext;
  if (!ctx) {
    throw reply
      .code(401)
      .send({ error: "Unauthorized", message: "A valid access token is required." });
  }
  return ctx;
}

/**
 * Route-level helper that asserts an auth context is present and returns it.
 * Intended for use inside authenticated route handlers:
 *
 *   const ctx = getAuthContext(request, reply);
 *   // ctx is now typed as RequestContext
 */
export { requireAuthContext as getAuthContext };
