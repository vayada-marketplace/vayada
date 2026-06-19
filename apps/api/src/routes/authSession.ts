import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  IdentityLifecycleCommandBus,
  IdentityLifecycleCommandResult,
  IdentityResourceLink,
  IdentityRepository,
  IdentityUser,
  OrganizationKind,
  Product,
  ResourceType,
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
  action: "auth.login" | "auth.logout" | "auth.compatibility_token.issued";
  actorUserId?: string;
  organizationId?: string;
  surface?: AuthSurface;
  resourceScope?: Record<string, string[]>;
  workosUserId?: string;
  workosOrgId?: string;
  workosSessionId?: string;
  requestId: string;
  occurredAt: string;
};

export type ProductAuditSink = {
  record(event: ProductAuditEvent): Promise<void>;
};

export type AuthSurface =
  | "platform-admin"
  | "booking-admin"
  | "pms-web"
  | "affiliate-dashboard"
  | "marketplace-web";

export type RequiredResourceLink = {
  product: Product;
  resourceType: ResourceType;
};

export type AuthSurfacePolicy = {
  requiredOrganizationKind: OrganizationKind | OrganizationKind[];
  callbackReturnUrl?: string;
  logoutReturnUrl?: string;
  legacyJwtSecret?: string;
  legacyJwtUserType?: string;
  requiredResourceLink?: RequiredResourceLink;
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
  surfacePolicies?: Partial<Record<AuthSurface, AuthSurfacePolicy>>;
  cookieSecure: boolean;
  cookieDomain?: string;
  legacyMarketplaceJwtSecret?: string;
};

const SESSION_COOKIE = "vayada_workos_session";
const STATE_COOKIE = "vayada_workos_state";
const CSRF_COOKIE = "vayada_auth_csrf";
const DEFAULT_SURFACE: AuthSurface = "platform-admin";
const MAX_PENDING_AUTH_STATES = 5;

type AuthStateContext = {
  state: string;
  surface: AuthSurface;
  returnTo?: string;
};

export const registerAuthSessionRoutes: FastifyPluginAsync<AuthSessionRouteOptions> = async (
  app: FastifyInstance,
  options: AuthSessionRouteOptions,
) => {
  app.get("/workos/login", async (request, reply) => {
    const query = request.query as {
      organization_id?: string;
      login_hint?: string;
      surface?: string;
      return_to?: string;
    };
    const surface = parseSurface(query.surface);
    getSurfacePolicy(surface, options);
    const returnTo = query.return_to
      ? validateReturnTo(query.return_to, options.allowedOrigins)
      : undefined;
    const state = randomBytes(24).toString("base64url");
    const authorizationUrl = options.authKitClient.getAuthorizationUrl({
      redirectUri: options.callbackUrl,
      state,
      organizationId: query.organization_id,
      loginHint: query.login_hint,
    });

    reply
      .headers({
        "set-cookie": [
          ...clearHostOnlyCookies([STATE_COOKIE, SESSION_COOKIE, CSRF_COOKIE], {
            secure: options.cookieSecure,
            domain: options.cookieDomain,
          }),
          serializeCookie(
            STATE_COOKIE,
            encodeStateCookie(
              addStateContext(decodeStateCookies(readCookies(request, STATE_COOKIE)), {
                state,
                surface,
                returnTo,
              }),
            ),
            {
              maxAge: 600,
              secure: options.cookieSecure,
              domain: options.cookieDomain,
            },
          ),
        ],
      })
      .redirect(authorizationUrl);
  });

  for (const path of [
    "/session",
    "/session/refresh",
    "/logout",
    "/compat/marketplace-admin-token",
    "/compat/booking-admin-token",
    "/compat/pms-web-token",
    "/compat/affiliate-dashboard-token",
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
    const stateContext = decodeStateCookies(readCookies(request, STATE_COOKIE)).find(
      (candidate) => candidate.state === query.state,
    );
    if (!query.code || !query.state || !stateContext) {
      return reply.code(400).send({
        error: "invalid_auth_state",
        message: "AuthKit callback state is missing or invalid.",
      });
    }
    const surfacePolicy = getSurfacePolicy(stateContext.surface, options);

    const session = await options.authKitClient.authenticateWithCode({
      code: query.code,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    let resolution: IdentityResolution;
    try {
      resolution = await resolveOrCreateIdentity(session, request, options, surfacePolicy);
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
    const callbackReturnUrl = stateContext.returnTo ?? surfacePolicy.callbackReturnUrl;
    if (callbackReturnUrl) {
      return reply.redirect(callbackReturnUrl);
    }
    return reply.send(
      toSessionResponse(session, resolution.user, csrfToken, resolution.organizationKind),
    );
  });

  app.get("/session", async (request, reply) => {
    const query = request.query as { surface?: string };
    const surfacePolicy = getSurfacePolicy(parseSurface(query.surface), options);
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
    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(session, options, surfacePolicy);
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    return reply.send(
      toSessionResponse(
        session,
        resolution.user,
        readCookie(request, CSRF_COOKIE),
        resolution.organizationKind,
      ),
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
    const body = request.body as { organizationId?: string; surface?: string } | undefined;
    const surfacePolicy = getSurfacePolicy(parseSurface(body?.surface), options);
    const session = await options.authKitClient.refreshSession({
      sealedSession,
      organizationId: body?.organizationId,
    });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(session, options, surfacePolicy);
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
      .send(
        toSessionResponse(
          session,
          resolution.user,
          readCookie(request, CSRF_COOKIE),
          resolution.organizationKind,
        ),
      );
  });

  app.post("/logout", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!passesCsrfCheck(request, options)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const body = request.body as { surface?: string; return_to?: string } | undefined;
    const surfacePolicy = getSurfacePolicy(parseSurface(body?.surface), options);
    const sealedSession = readCookie(request, SESSION_COOKIE);
    const returnTo = body?.return_to
      ? validateReturnTo(body.return_to, options.allowedOrigins)
      : (surfacePolicy.logoutReturnUrl ?? options.logoutReturnUrl);
    let logoutUrl = returnTo;
    if (sealedSession) {
      const session = await options.authKitClient.authenticateSession({ sealedSession });
      if (session) {
        const resolution = await resolveExistingIdentity(session, options, surfacePolicy).catch(
          () => null,
        );
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
        returnTo,
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

  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/marketplace-admin-token",
    surface: "platform-admin",
    userType: "admin",
  });
  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/booking-admin-token",
    surface: "booking-admin",
    userType: "hotel",
  });
  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/pms-web-token",
    surface: "pms-web",
    userType: "hotel",
  });
  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/affiliate-dashboard-token",
    surface: "affiliate-dashboard",
    userType: "affiliate",
  });
};

function parseSurface(value: string | undefined): AuthSurface {
  if (!value) return DEFAULT_SURFACE;
  if (
    value === "platform-admin" ||
    value === "booking-admin" ||
    value === "pms-web" ||
    value === "affiliate-dashboard" ||
    value === "marketplace-web"
  ) {
    return value;
  }
  throw new Error(`Unsupported AuthKit surface: ${value}`);
}

function getSurfacePolicy(
  surface: AuthSurface,
  options: AuthSessionRouteOptions,
): AuthSurfacePolicy {
  const defaultPlatformPolicy: AuthSurfacePolicy = {
    requiredOrganizationKind: options.requiredOrganizationKind,
    callbackReturnUrl: options.callbackReturnUrl,
    logoutReturnUrl: options.logoutReturnUrl,
    legacyJwtSecret: options.legacyMarketplaceJwtSecret,
    legacyJwtUserType: "admin",
  };
  if (surface === DEFAULT_SURFACE) {
    return { ...defaultPlatformPolicy, ...options.surfacePolicies?.[surface] };
  }
  const configured = options.surfacePolicies?.[surface];
  if (!configured) {
    throw new Error(`AuthKit surface is not configured: ${surface}`);
  }
  return configured;
}

function validateReturnTo(rawReturnTo: string, allowedOrigins: string[]): string {
  let url: URL;
  try {
    url = new URL(rawReturnTo);
  } catch {
    throw new Error("Invalid AuthKit return_to URL");
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error("AuthKit return_to origin is not allowed");
  }
  return url.toString();
}

function addStateContext(existing: AuthStateContext[], next: AuthStateContext): AuthStateContext[] {
  return [...existing.filter((candidate) => candidate.state !== next.state), next].slice(
    -MAX_PENDING_AUTH_STATES,
  );
}

function encodeStateCookie(input: AuthStateContext[]): string {
  return `v1.${Buffer.from(JSON.stringify(input)).toString("base64url")}`;
}

function decodeStateCookies(values: string[]): AuthStateContext[] {
  return values.flatMap(decodeStateCookie);
}

function decodeStateCookie(value: string | undefined): AuthStateContext[] {
  if (!value) return [];
  if (!value.startsWith("v1.")) {
    return [{ state: value, surface: DEFAULT_SURFACE }];
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8"));
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    return candidates.flatMap((candidate) => {
      const stateContext = parseStateContext(candidate);
      return stateContext ? [stateContext] : [];
    });
  } catch {
    return [];
  }
}

function parseStateContext(candidate: unknown): AuthStateContext | null {
  if (!candidate || typeof candidate !== "object") return null;
  const raw = candidate as { state?: unknown; surface?: unknown; returnTo?: unknown };
  if (typeof raw.state !== "string") return null;
  try {
    return {
      state: raw.state,
      surface: parseSurface(typeof raw.surface === "string" ? raw.surface : undefined),
      returnTo: typeof raw.returnTo === "string" ? raw.returnTo : undefined,
    };
  } catch {
    return null;
  }
}

function registerCompatibilityTokenRoute(
  app: FastifyInstance,
  options: AuthSessionRouteOptions,
  route: { path: string; surface: AuthSurface; userType: string },
): void {
  app.post(route.path, async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const surfacePolicy = getSurfacePolicy(route.surface, options);
    if (!surfacePolicy.legacyJwtSecret) {
      return reply.code(404).send({ error: "legacy_compatibility_bridge_not_configured" });
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
    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(session, options, surfacePolicy);
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    const expiresIn = 15 * 60;
    const resourceScope = resolution.resourceScope
      ? { [resourceScopeKey(resolution.resourceScope)]: resolution.resourceScope.resourceIds }
      : undefined;
    await options.productAuditSink.record({
      action: "auth.compatibility_token.issued",
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      surface: route.surface,
      resourceScope,
      workosUserId: session.user.id,
      workosOrgId: session.organizationId,
      workosSessionId: session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });
    return reply.send({
      accessToken: signLegacyMarketplaceJwt(
        {
          sub: resolution.user.userId,
          email: resolution.user.email,
          type: surfacePolicy.legacyJwtUserType ?? route.userType,
          org: resolution.organizationId,
          surface: route.surface,
          resources: resourceScope,
        },
        surfacePolicy.legacyJwtSecret,
        expiresIn,
      ),
      expiresIn,
      tokenType: "Bearer",
    });
  });
}

async function resolveOrCreateIdentity(
  session: AuthKitSession,
  request: FastifyRequest,
  options: AuthSessionRouteOptions,
  surfacePolicy: AuthSurfacePolicy,
): Promise<IdentityResolution> {
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
  const access = await resolveOrganizationAccess(session, user.userId, options, surfacePolicy);
  return { user, ...access };
}

async function resolveExistingIdentity(
  session: AuthKitSession,
  options: AuthSessionRouteOptions,
  surfacePolicy: AuthSurfacePolicy,
): Promise<IdentityResolution> {
  const verified = await options.tokenVerifier(session.accessToken);
  const user = await options.identityRepository.findUserByProviderUserId(
    "workos",
    verified.workosUserId,
  );
  if (!user) {
    throw new Error(`No internal user for WorkOS user ${verified.workosUserId}`);
  }
  const access = await resolveOrganizationAccess(
    { ...session, organizationId: verified.workosOrgId ?? session.organizationId },
    user.userId,
    options,
    surfacePolicy,
  );
  return { user, ...access };
}

type IdentityResolution = {
  user: IdentityUser;
  organizationId?: string;
  organizationKind?: OrganizationKind;
  resourceScope?: {
    product: Product;
    resourceType: ResourceType;
    resourceIds: string[];
  };
};

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
  surfacePolicy: AuthSurfacePolicy,
): Promise<Omit<IdentityResolution, "user">> {
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
  if (!matchesOrganizationKind(organization.kind, surfacePolicy.requiredOrganizationKind)) {
    throw new Error(
      `Selected organization must be ${requiredOrganizationKindLabel(
        surfacePolicy.requiredOrganizationKind,
      )}`,
    );
  }
  const membership = await options.identityRepository.findActiveMembership(
    userId,
    organization.organizationId,
  );
  if (!membership || membership.status !== "active") {
    throw new Error("No active membership for selected organization");
  }
  if (surfacePolicy.requiredResourceLink) {
    const links = await options.identityRepository.findLinkedResources(organization.organizationId);
    const matchingLinks = findRequiredResourceLinks(links, surfacePolicy.requiredResourceLink);
    if (matchingLinks.length === 0) {
      throw new Error(
        `Selected organization is missing an active ${surfacePolicy.requiredResourceLink.product}/${surfacePolicy.requiredResourceLink.resourceType} resource link`,
      );
    }
    return {
      organizationId: organization.organizationId,
      organizationKind: organization.kind,
      resourceScope: {
        ...surfacePolicy.requiredResourceLink,
        resourceIds: matchingLinks.map((link) => link.resourceId),
      },
    };
  }
  return { organizationId: organization.organizationId, organizationKind: organization.kind };
}

function findRequiredResourceLinks(
  links: IdentityResourceLink[],
  required: RequiredResourceLink,
): IdentityResourceLink[] {
  return links.filter(
    (link) =>
      link.status === "active" &&
      link.product === required.product &&
      link.resourceType === required.resourceType,
  );
}

function resourceScopeKey(scope: { product: Product; resourceType: ResourceType }): string {
  return `${scope.product}:${scope.resourceType}`;
}

function matchesOrganizationKind(
  actual: OrganizationKind,
  required: OrganizationKind | OrganizationKind[],
): boolean {
  return Array.isArray(required) ? required.includes(actual) : actual === required;
}

function requiredOrganizationKindLabel(required: OrganizationKind | OrganizationKind[]): string {
  return Array.isArray(required) ? required.join(" or ") : required;
}

function toSessionResponse(
  session: AuthKitSession,
  user: IdentityUser,
  csrfToken?: string,
  organizationKind?: OrganizationKind,
) {
  return {
    accessToken: session.accessToken,
    csrfToken,
    organizationId: session.organizationId,
    organizationKind,
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
  claims: {
    sub: string;
    email: string;
    type: string;
    org?: string;
    surface?: AuthSurface;
    resources?: Record<string, string[]>;
  },
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
  return readCookies(request, name)[0];
}

function readCookies(request: FastifyRequest, name: string): string[] {
  const header = request.headers.cookie;
  if (!header) return [];
  const cookies = header.split(";").map((part) => part.trim());
  const values: string[] = [];
  for (const cookie of cookies) {
    const [cookieName, ...rawValue] = cookie.split("=");
    if (cookieName === name) {
      values.push(decodeURIComponent(rawValue.join("=")));
    }
  }
  return values;
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

function clearHostOnlyCookies(
  names: string[],
  options: { secure: boolean; domain?: string },
): string[] {
  if (!options.domain) return [];
  return names.map((name) =>
    serializeCookie(name, "", {
      maxAge: 0,
      secure: options.secure,
    }),
  );
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
