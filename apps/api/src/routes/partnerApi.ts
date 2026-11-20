import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  formatScopes,
  parseScopes,
  type PartnerAccess,
  type PartnerApp,
  type PartnerConnectionsRepository,
} from "../domains/partnerConnections.js";

/**
 * VAY-2436: what partner apps call (contract "What Vayada accepts and sends", P-VAY-32). Mounted at
 * /partner, outside /api: the WorkOS check never runs here and these routes never read it.
 *
 *   POST /partner/oauth/token    form fields, client id and secret as HTTP Basic (RFC 6749):
 *                                grant_type=authorization_code (code, redirect_uri, code_verifier)
 *                                or refresh_token (refresh_token, optional scope). Errors the OAuth
 *                                way: { "error": "invalid_grant" }.
 *   POST /partner/oauth/revoke   form field token (RFC 7009): any of the app's tokens disconnects its
 *                                hotel. Always 200 for a known client.
 *   GET  /partner/v1/hotel       Bearer access token: the hotel it works for.
 *
 * /partner/v1 errors are { "error": { "code", "message", "details"? } }; up to 60 requests a minute
 * per hotel (next-api runs as one task, so the count is global), then 429 rate_limited + Retry-After.
 */
export const PARTNER_REQUESTS_PER_MINUTE = 60;

export type PartnerApiRoutesOptions = {
  repository: PartnerConnectionsRepository;
  requestsPerMinute?: number;
  now?: () => number;
};

type OAuthError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unsupported_grant_type"
  | "server_error";

type PartnerErrorCode =
  | "invalid_payload"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "internal_error";

export async function registerPartnerApiRoutes(
  app: FastifyInstance,
  options: PartnerApiRoutesOptions,
) {
  app.addHook("onClose", async () => options.repository.close?.());
  // The parent's own options carry its prefix (/partner): it must not replace the children's.
  const { repository, requestsPerMinute, now } = options;
  await app.register(registerOAuthRoutes, { repository, prefix: "/oauth" });
  await app.register(registerV1Routes, { repository, requestsPerMinute, now, prefix: "/v1" });
}

async function registerOAuthRoutes(app: FastifyInstance, { repository }: PartnerApiRoutesOptions) {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16_384 },
    (_request, body, done) => {
      const fields: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body as string)) {
        // RFC 6749 3.1: a parameter is sent at most once.
        if (Object.hasOwn(fields, key)) return done(badRequest("Repeated form field"), undefined);
        fields[key] = value;
      }
      done(null, fields);
    },
  );
  app.setErrorHandler((error: FastifyError, request, reply) => {
    noStore(reply);
    if ((error.statusCode ?? 500) < 500) return oauthError(reply, 400, "invalid_request");
    request.log.error({ err: error }, "Partner OAuth call failed");
    return oauthError(reply, 500, "server_error");
  });

  app.post("/token", async (request, reply) => {
    noStore(reply);
    const client = await authenticateClient(request, repository);
    if (!client) return invalidClient(reply);
    const body = formFields(request);
    if (!body) return oauthError(reply, 400, "invalid_request");

    const grantType = body["grant_type"];
    let result: Awaited<ReturnType<PartnerConnectionsRepository["refresh"]>>;
    if (grantType === "authorization_code") {
      const { code, redirect_uri: redirectUri, code_verifier: codeVerifier } = body;
      if (!code || !redirectUri || !codeVerifier) return oauthError(reply, 400, "invalid_request");
      result = await repository.exchangeCode({ app: client, code, redirectUri, codeVerifier });
    } else if (grantType === "refresh_token") {
      const refreshToken = body["refresh_token"];
      if (!refreshToken) return oauthError(reply, 400, "invalid_request");
      const scope = body["scope"];
      const scopes = scope === undefined ? null : parseScopes(scope);
      if (scope !== undefined && !scopes?.length) return oauthError(reply, 400, "invalid_scope");
      result = await repository.refresh({ app: client, refreshToken, scopes });
    } else {
      return oauthError(reply, 400, grantType ? "unsupported_grant_type" : "invalid_request");
    }
    if ("error" in result) return oauthError(reply, 400, result.error);
    return reply.send({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: formatScopes(result.scopes),
      hotel: result.hotel,
    });
  });

  app.post("/revoke", async (request, reply) => {
    noStore(reply);
    const client = await authenticateClient(request, repository);
    if (!client) return invalidClient(reply);
    const token = formFields(request)?.["token"];
    if (!token) return oauthError(reply, 400, "invalid_request");
    await repository.revokeByPartner({ app: client, token });
    return reply.status(200).send();
  });
}

async function registerV1Routes(
  app: FastifyInstance,
  {
    repository,
    requestsPerMinute = PARTNER_REQUESTS_PER_MINUTE,
    now = Date.now,
  }: PartnerApiRoutesOptions,
) {
  const limit = createMinuteLimiter(requestsPerMinute, now);
  const accessByRequest = new WeakMap<FastifyRequest, PartnerAccess>();

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if ((error.statusCode ?? 500) < 500)
      return partnerError(reply, 400, "invalid_payload", "The request could not be read.");
    request.log.error({ err: error }, "Partner API call failed");
    return partnerError(reply, 500, "internal_error", "Something went wrong. Try again later.");
  });
  app.setNotFoundHandler((_request, reply) =>
    partnerError(reply, 404, "not_found", "There is no such partner call."),
  );
  app.addHook("onRequest", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const access = token ? await repository.authenticateAccessToken(token) : null;
    if (!access) {
      reply.header("WWW-Authenticate", 'Bearer realm="vayada-partner"');
      return partnerError(reply, 401, "unauthenticated", "A valid access token is required.");
    }
    const allowed = limit(`${access.appId}:${access.propertyId}`);
    if (!allowed.ok) {
      reply.header("Retry-After", String(allowed.retryAfterSeconds));
      return partnerError(
        reply,
        429,
        "rate_limited",
        "Too many requests for this hotel. Try again soon.",
      );
    }
    accessByRequest.set(request, access);
  });
  const accessOf = (request: FastifyRequest) => {
    const access = accessByRequest.get(request);
    if (!access) throw new Error("Partner access missing");
    return access;
  };

  app.get("/hotel", async (request, reply) => {
    const hotel = await repository.readHotel(accessOf(request).propertyId);
    if (!hotel) return partnerError(reply, 404, "not_found", "The hotel no longer exists.");
    return reply.header("Cache-Control", "private, no-store").send(hotel);
  });
}

/** RFC 6749 2.3.1: HTTP Basic with the form-encoded client id and secret. */
export function basicCredentials(
  header: string | undefined,
): { clientId: string; secret: string } | null {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header?.trim() ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  try {
    const decode = (value: string) => decodeURIComponent(value.replaceAll("+", " "));
    const clientId = decode(decoded.slice(0, colon));
    const secret = decode(decoded.slice(colon + 1));
    return clientId && secret ? { clientId, secret } : null;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header?.trim() ?? "");
  return match?.[1] ?? null;
}

async function authenticateClient(
  request: FastifyRequest,
  repository: PartnerConnectionsRepository,
): Promise<PartnerApp | null> {
  const credentials = basicCredentials(request.headers.authorization);
  return credentials
    ? repository.authenticateClient(credentials.clientId, credentials.secret)
    : null;
}

function formFields(request: FastifyRequest): Record<string, string> | null {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  const body = request.body;
  return body && typeof body === "object" ? (body as Record<string, string>) : null;
}

function noStore(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
}

function oauthError(reply: FastifyReply, status: number, error: OAuthError) {
  return reply.status(status).send({ error });
}

function invalidClient(reply: FastifyReply) {
  reply.header("WWW-Authenticate", 'Basic realm="vayada-partner"');
  return oauthError(reply, 401, "invalid_client");
}

function partnerError(
  reply: FastifyReply,
  status: number,
  code: PartnerErrorCode,
  message: string,
  details?: string[],
) {
  return reply.status(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function createMinuteLimiter(limit: number, now: () => number) {
  const counts = new Map<string, number>();
  let window = Number.NaN;
  return (key: string): { ok: true } | { ok: false; retryAfterSeconds: number } => {
    const at = now();
    const current = Math.floor(at / 60_000);
    if (current !== window) {
      window = current;
      counts.clear();
    }
    const used = counts.get(key) ?? 0;
    if (used >= limit)
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil(((current + 1) * 60_000 - at) / 1_000)),
      };
    counts.set(key, used + 1);
    return { ok: true };
  };
}
