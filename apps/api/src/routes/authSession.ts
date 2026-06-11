import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  IdentityLifecycleCommandBus,
  IdentityLifecycleCommandResult,
  IdentityRepository,
  IdentityUser,
  OrganizationKind,
  TokenVerifier,
} from "@vayada/backend-auth";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

export type AuthKitUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
};

export type AuthKitSession = {
  accessToken: string;
  sealedSession: string;
  user: AuthKitUser;
  organizationId?: string;
  sessionId?: string;
};

export type AuthKitClient = {
  getAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    organizationId?: string;
    loginHint?: string;
  }): string;
  authenticateWithCode(input: {
    code: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthKitSession>;
  authenticateSession(input: { sealedSession: string }): Promise<AuthKitSession | null>;
  refreshSession(input: {
    sealedSession: string;
    organizationId?: string;
  }): Promise<AuthKitSession | null>;
  getLogoutUrl(input: { sealedSession: string; returnTo: string }): Promise<string>;
  updateUserExternalId(input: { workosUserId: string; externalId: string }): Promise<void>;
};

export type ProductAuditEvent = {
  action: "auth.login" | "auth.logout";
  actorUserId?: string;
  organizationId?: string;
  workosUserId?: string;
  workosOrgId?: string;
  workosSessionId?: string;
  requestId: string;
  occurredAt: string;
};

export type ProductAuditSink = {
  record(event: ProductAuditEvent): Promise<void>;
};

export type AuthSessionRouteOptions = {
  authKitClient: AuthKitClient;
  identityRepository: IdentityRepository;
  lifecycleCommandBus: IdentityLifecycleCommandBus;
  productAuditSink: ProductAuditSink;
  tokenVerifier: TokenVerifier;
  callbackUrl: string;
  callbackReturnUrl?: string;
  logoutReturnUrl: string;
  allowedOrigins: string[];
  requiredOrganizationKind: OrganizationKind;
  cookieSecure: boolean;
  cookieDomain?: string;
  legacyMarketplaceJwtSecret?: string;
};

const SESSION_COOKIE = "vayada_workos_session";
const STATE_COOKIE = "vayada_workos_state";
const CSRF_COOKIE = "vayada_auth_csrf";

export const registerAuthSessionRoutes: FastifyPluginAsync<AuthSessionRouteOptions> = async (
  app: FastifyInstance,
  options: AuthSessionRouteOptions,
) => {
  app.get("/workos/login", async (request, reply) => {
    const query = request.query as {
      organization_id?: string;
      login_hint?: string;
    };
    const state = randomBytes(24).toString("base64url");
    const authorizationUrl = options.authKitClient.getAuthorizationUrl({
      redirectUri: options.callbackUrl,
      state,
      organizationId: query.organization_id,
      loginHint: query.login_hint,
    });

    reply
      .header(
        "set-cookie",
        serializeCookie(STATE_COOKIE, state, {
          maxAge: 600,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
      )
      .redirect(authorizationUrl);
  });

  for (const path of [
    "/session",
    "/session/refresh",
    "/logout",
    "/compat/marketplace-admin-token",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options)) {
        return reply.code(403).send();
      }
      return reply.code(204).send();
    });
  }

  app.get("/workos/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      return reply.code(400).send({
        error: "authkit_callback_error",
        message: query.error_description ?? query.error,
      });
    }
    if (!query.code || !query.state || query.state !== readCookie(request, STATE_COOKIE)) {
      return reply.code(400).send({
        error: "invalid_auth_state",
        message: "AuthKit callback state is missing or invalid.",
      });
    }

    const session = await options.authKitClient.authenticateWithCode({
      code: query.code,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    let resolution: { user: IdentityUser; organizationId?: string };
    try {
      resolution = await resolveOrCreateIdentity(session, request, options);
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    await options.productAuditSink.record({
      action: "auth.login",
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      workosUserId: session.user.id,
      workosOrgId: session.organizationId,
      workosSessionId: session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });

    const csrfToken = randomBytes(24).toString("base64url");
    reply.headers({
      "set-cookie": [
        serializeCookie(STATE_COOKIE, "", {
          maxAge: 0,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(SESSION_COOKIE, session.sealedSession, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(CSRF_COOKIE, csrfToken, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
          httpOnly: false,
        }),
      ],
    });
    if (options.callbackReturnUrl) {
      return reply.redirect(options.callbackReturnUrl);
    }
    return reply.send(toSessionResponse(session, resolution.user, csrfToken));
  });

  app.get("/session", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    let resolution: { user: IdentityUser; organizationId?: string };
    try {
      resolution = await resolveExistingIdentity(session, options);
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    return reply.send(
      toSessionResponse(session, resolution.user, readCookie(request, CSRF_COOKIE)),
    );
  });

  app.post("/session/refresh", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!passesCsrfCheck(request, options)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const body = request.body as { organizationId?: string } | undefined;
    const session = await options.authKitClient.refreshSession({
      sealedSession,
      organizationId: body?.organizationId,
    });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    let resolution: { user: IdentityUser; organizationId?: string };
    try {
      resolution = await resolveExistingIdentity(session, options);
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    reply
      .header(
        "set-cookie",
        serializeCookie(SESSION_COOKIE, session.sealedSession, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
      )
      .send(toSessionResponse(session, resolution.user, readCookie(request, CSRF_COOKIE)));
  });

  app.post("/logout", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!passesCsrfCheck(request, options)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE);
    let logoutUrl = options.logoutReturnUrl;
    if (sealedSession) {
      const session = await options.authKitClient.authenticateSession({ sealedSession });
      if (session) {
        const resolution = await resolveExistingIdentity(session, options).catch(() => null);
        await options.productAuditSink.record({
          action: "auth.logout",
          actorUserId: resolution?.user.userId,
          organizationId: resolution?.organizationId,
          workosUserId: session.user.id,
          workosOrgId: session.organizationId,
          workosSessionId: session.sessionId,
          requestId: request.id,
          occurredAt: new Date().toISOString(),
        });
      }
      logoutUrl = await options.authKitClient.getLogoutUrl({
        sealedSession,
        returnTo: options.logoutReturnUrl,
      });
    }

    reply
      .headers({
        "set-cookie": [
          serializeCookie(SESSION_COOKIE, "", {
            maxAge: 0,
            secure: options.cookieSecure,
            domain: options.cookieDomain,
          }),
          serializeCookie(CSRF_COOKIE, "", {
            maxAge: 0,
            secure: options.cookieSecure,
            domain: options.cookieDomain,
            httpOnly: false,
          }),
        ],
      })
      .send({ logoutUrl });
  });

  app.post("/compat/marketplace-admin-token", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!options.legacyMarketplaceJwtSecret) {
      return reply.code(404).send({ error: "legacy_marketplace_bridge_not_configured" });
    }
    if (!passesCsrfCheck(request, options)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    let resolution: { user: IdentityUser; organizationId?: string };
    try {
      resolution = await resolveExistingIdentity(session, options);
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    const expiresIn = 15 * 60;
    return reply.send({
      accessToken: signLegacyMarketplaceJwt(
        {
          sub: resolution.user.userId,
          email: resolution.user.email,
          type: "admin",
        },
        options.legacyMarketplaceJwtSecret,
        expiresIn,
      ),
      expiresIn,
      tokenType: "Bearer",
    });
  });
};

async function resolveOrCreateIdentity(
  session: AuthKitSession,
  request: FastifyRequest,
  options: AuthSessionRouteOptions,
): Promise<{ user: IdentityUser; organizationId?: string }> {
  let user = await options.identityRepository.findUserByProviderUserId("workos", session.user.id);
  if (!user) {
    const result = await options.lifecycleCommandBus.execute({
      commandType: "identity.user.create",
      commandId: randomUUID(),
      idempotencyKey: `workos-jit:${session.user.id}`,
      audit: {
        actor: { kind: "system", service: "apps/api-authkit" },
        source: "web",
        requestId: request.id,
        correlationId: session.sessionId,
        reason: "AuthKit SSO/JIT first arrival",
        requestedAt: new Date().toISOString(),
      },
      payload: {
        email: session.user.email,
        name: session.user.name ?? undefined,
        initialStatus: "active",
        providerIdentity: {
          provider: "workos",
          providerUserId: session.user.id,
          providerEmailVerified: session.user.emailVerified,
        },
      },
    });
    user = await findUserAfterLifecycle(options.identityRepository, session, result);
    await options.authKitClient.updateUserExternalId({
      workosUserId: session.user.id,
      externalId: user.userId,
    });
  }
  const organizationId = await resolveOrganizationAccess(session, user.userId, options);
  return { user, organizationId };
}

async function resolveExistingIdentity(
  session: AuthKitSession,
  options: AuthSessionRouteOptions,
): Promise<{ user: IdentityUser; organizationId?: string }> {
  const verified = await options.tokenVerifier(session.accessToken);
  const user = await options.identityRepository.findUserByProviderUserId(
    "workos",
    verified.workosUserId,
  );
  if (!user) {
    throw new Error(`No internal user for WorkOS user ${verified.workosUserId}`);
  }
  const organizationId = await resolveOrganizationAccess(
    { ...session, organizationId: verified.workosOrgId ?? session.organizationId },
    user.userId,
    options,
  );
  return { user, organizationId };
}

async function findUserAfterLifecycle(
  repository: IdentityRepository,
  session: AuthKitSession,
  result: IdentityLifecycleCommandResult,
): Promise<IdentityUser> {
  const user = await repository.findUserByProviderUserId("workos", session.user.id);
  if (user) return user;
  if (result.userId) {
    return {
      userId: result.userId,
      email: session.user.email,
      status: "active",
    };
  }
  throw new Error("Identity lifecycle command did not create a resolvable user");
}

async function resolveOrganizationAccess(
  session: AuthKitSession,
  userId: string,
  options: AuthSessionRouteOptions,
): Promise<string | undefined> {
  if (!session.organizationId) {
    throw new Error("AuthKit session is missing selected organization");
  }
  const organization = await options.identityRepository.findOrganizationByWorkosOrgId(
    session.organizationId,
  );
  if (!organization || !organization.workosOrgId) {
    throw new Error(`No WorkOS-managed organization for ${session.organizationId}`);
  }
  if (organization.status !== "active") {
    throw new Error(`Organization ${organization.organizationId} is not active`);
  }
  if (organization.kind !== options.requiredOrganizationKind) {
    throw new Error(`Selected organization must be ${options.requiredOrganizationKind}`);
  }
  const membership = await options.identityRepository.findActiveMembership(
    userId,
    organization.organizationId,
  );
  if (!membership || membership.status !== "active") {
    throw new Error("No active membership for selected organization");
  }
  return organization.organizationId;
}

function toSessionResponse(session: AuthKitSession, user: IdentityUser, csrfToken?: string) {
  return {
    accessToken: session.accessToken,
    csrfToken,
    organizationId: session.organizationId,
    user: {
      id: user.userId,
      email: user.email,
      status: user.status,
      workosUserId: session.user.id,
    },
  };
}

function writeCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthSessionRouteOptions,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!options.allowedOrigins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Credentials", "true")
    .header("Access-Control-Allow-Headers", "content-type,x-vayada-csrf")
    .header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

function signLegacyMarketplaceJwt(
  claims: { sub: string; email: string; type: string },
  secret: string,
  expiresInSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    ...claims,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  const cookies = header.split(";").map((part) => part.trim());
  for (const cookie of cookies) {
    const [cookieName, ...rawValue] = cookie.split("=");
    if (cookieName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean; domain?: string; httpOnly?: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/auth",
    `Max-Age=${options.maxAge}`,
    "SameSite=Lax",
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
}

function toAuthError(error: unknown) {
  return {
    error: "auth_session_rejected",
    message: error instanceof Error ? error.message : "AuthKit session was rejected.",
  };
}

function passesCsrfCheck(request: FastifyRequest, options: AuthSessionRouteOptions): boolean {
  const origin = request.headers.origin;
  if (origin && !options.allowedOrigins.includes(origin)) {
    return false;
  }
  const csrfCookie = readCookie(request, CSRF_COOKIE);
  const csrfHeader = request.headers["x-vayada-csrf"];
  return typeof csrfHeader === "string" && csrfHeader.length > 0 && csrfHeader === csrfCookie;
}
