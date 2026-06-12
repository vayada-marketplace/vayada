import type {
  IdentityLifecycleCommand,
  IdentityLifecycleCommandBus,
  IdentityRepository,
  IdentityUser,
  TokenVerifier,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { AuthKitClient, AuthKitSession, ProductAuditEvent } from "./routes/authSession.js";

const user: IdentityUser = {
  userId: "user_platform_admin",
  email: "admin@example.com",
  status: "active",
};

const session: AuthKitSession = {
  accessToken: "workos-access-token",
  sealedSession: "sealed-session",
  sessionId: "session_workos",
  organizationId: "org_workos_platform",
  user: {
    id: "user_workos_platform",
    email: "admin@example.com",
    emailVerified: true,
    name: "Admin Example",
  },
};

describe("AuthKit session routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("redirects to the hosted AuthKit URL and stores callback state", async () => {
    const authKitClient = createAuthKitClient();
    app = buildAuthSessionApp({ authKitClient });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/login?login_hint=admin%40example.com",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("https://auth.workos.test/authorize?");
    expect(response.headers.location).toContain("login_hint=admin%40example.com");
    expect(response.headers["set-cookie"]).toContain("vayada_workos_state=");
  });

  it("completes callback for an existing linked user and emits login audit", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    app = buildAuthSessionApp({
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: "workos-access-token",
      csrfToken: expect.any(String),
      organizationId: "org_workos_platform",
      user: {
        id: "user_platform_admin",
        workosUserId: "user_workos_platform",
      },
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_state=;"),
        expect.stringContaining("vayada_workos_session=sealed-session"),
      ]),
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.login",
        actorUserId: "user_platform_admin",
        organizationId: "org_platform",
        workosUserId: "user_workos_platform",
      }),
    ]);
  });

  it("redirects to the configured frontend success URL after callback when enabled", async () => {
    app = buildAuthSessionApp({
      callbackReturnUrl: "https://admin.localhost/dashboard",
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://admin.localhost/dashboard");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("vayada_workos_session=sealed-session")]),
    );
  });

  it("uses the identity lifecycle command bus for JIT-first user creation", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const externalIdUpdates: Array<{ workosUserId: string; externalId: string }> = [];
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async updateUserExternalId(input) {
          externalIdUpdates.push(input);
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => null,
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: "user_jit_created",
            events: [],
          };
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe("user_jit_created");
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        idempotencyKey: "workos-jit:user_workos_platform",
        payload: expect.objectContaining({
          email: "admin@example.com",
          providerIdentity: expect.objectContaining({
            provider: "workos",
            providerUserId: "user_workos_platform",
          }),
        }),
      }),
    ]);
    expect(externalIdUpdates).toEqual([
      {
        workosUserId: "user_workos_platform",
        externalId: "user_jit_created",
      },
    ]);
  });

  it("rejects callback when the selected WorkOS organization is unknown", async () => {
    app = buildAuthSessionApp({
      identityRepository: createIdentityRepository({
        organizationByWorkosOrgId: async () => null,
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "auth_session_rejected",
      message: "No WorkOS-managed organization for org_workos_platform",
    });
  });

  it("rejects callback when the selected organization membership is inactive", async () => {
    app = buildAuthSessionApp({
      identityRepository: createIdentityRepository({
        activeMembership: async () => ({
          membershipId: "membership_platform",
          status: "inactive",
          roleKey: "platform_admin",
          workosMembershipId: "om_platform",
          workosRoleSlugs: ["platform_admin"],
        }),
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("No active membership for selected organization");
  });

  it("rejects callback when AuthKit session has no selected organization", async () => {
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async authenticateWithCode() {
          return {
            ...session,
            organizationId: undefined,
          };
        },
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("AuthKit session is missing selected organization");
  });

  it("refreshes a sealed session and returns an in-memory bearer token", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        organizationId: "org_workos_platform",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBe("refreshed-workos-access-token");
    expect(response.json().csrfToken).toBe("csrf-token");
    expect(response.headers["set-cookie"]).toContain(
      "vayada_workos_session=refreshed-sealed-session",
    );
  });

  it("sets CORS headers for credentialed browser session refreshes", async () => {
    app = buildAuthSessionApp();

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/auth/session/refresh",
      headers: {
        origin: "https://admin.localhost",
        "access-control-request-method": "POST",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://admin.localhost");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("mints a short-lived marketplace admin compatibility token after platform session resolution", async () => {
    app = buildAuthSessionApp({
      legacyMarketplaceJwtSecret: "legacy-secret",
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/compat/marketplace-admin-token",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: expect.any(String),
      expiresIn: 900,
      tokenType: "Bearer",
    });
    expect(readJwtPayload(response.json().accessToken)).toMatchObject({
      sub: "user_platform_admin",
      email: "admin@example.com",
      type: "admin",
    });
  });

  it("clears the sealed session and returns the WorkOS logout URL", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    app = buildAuthSessionApp({
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      logoutUrl: "https://auth.workos.test/logout?return_to=https%3A%2F%2Fadmin.localhost%2Flogin",
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("vayada_workos_session=;")]),
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.logout",
        actorUserId: "user_platform_admin",
      }),
    ]);
  });

  it("rejects refresh when CSRF header is missing", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "csrf_rejected" });
  });
});

function buildAuthSessionApp(
  options: {
    authKitClient?: AuthKitClient;
    identityRepository?: IdentityRepository;
    lifecycleCommandBus?: IdentityLifecycleCommandBus;
    productAuditSink?: { record(event: ProductAuditEvent): Promise<void> };
    tokenVerifier?: TokenVerifier;
    callbackReturnUrl?: string;
    legacyMarketplaceJwtSecret?: string;
  } = {},
) {
  return buildApp({
    logger: false,
    authSession: {
      authKitClient: options.authKitClient ?? createAuthKitClient(),
      identityRepository: options.identityRepository ?? createIdentityRepository(),
      lifecycleCommandBus: options.lifecycleCommandBus ?? createLifecycleCommandBus(),
      productAuditSink: options.productAuditSink ?? {
        async record() {},
      },
      tokenVerifier: options.tokenVerifier ?? createTokenVerifier(),
      callbackUrl: "https://api.localhost/auth/workos/callback",
      callbackReturnUrl: options.callbackReturnUrl,
      logoutReturnUrl: "https://admin.localhost/login",
      allowedOrigins: ["https://admin.localhost"],
      requiredOrganizationKind: "platform",
      cookieSecure: false,
      legacyMarketplaceJwtSecret: options.legacyMarketplaceJwtSecret,
    },
  });
}

function readJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("JWT payload segment missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function createAuthKitClient(overrides: Partial<AuthKitClient> = {}): AuthKitClient {
  return {
    getAuthorizationUrl(input) {
      const url = new URL("https://auth.workos.test/authorize");
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("state", input.state);
      if (input.organizationId) url.searchParams.set("organization_id", input.organizationId);
      if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
      return url.toString();
    },
    async authenticateWithCode() {
      return session;
    },
    async authenticateSession() {
      return session;
    },
    async refreshSession() {
      return {
        ...session,
        accessToken: "refreshed-workos-access-token",
        sealedSession: "refreshed-sealed-session",
      };
    },
    async getLogoutUrl(input) {
      return `https://auth.workos.test/logout?return_to=${encodeURIComponent(input.returnTo)}`;
    },
    async updateUserExternalId() {},
    ...overrides,
  };
}

function createIdentityRepository(
  overrides: {
    userByProviderUserId?: IdentityRepository["findUserByProviderUserId"];
    organizationByWorkosOrgId?: IdentityRepository["findOrganizationByWorkosOrgId"];
    activeMembership?: IdentityRepository["findActiveMembership"];
  } = {},
): IdentityRepository {
  return {
    findUserByProviderUserId: overrides.userByProviderUserId ?? (async () => user),
    findOrganizationByWorkosOrgId:
      overrides.organizationByWorkosOrgId ??
      (async () => ({
        organizationId: "org_platform",
        workosOrgId: "org_workos_platform",
        kind: "platform",
        status: "active",
      })),
    findActiveMembership:
      overrides.activeMembership ??
      (async () => ({
        membershipId: "membership_platform",
        status: "active",
        roleKey: "platform_admin",
        workosMembershipId: "om_platform",
        workosRoleSlugs: ["platform_admin"],
      })),
    async findLinkedResources() {
      return [];
    },
  };
}

function createLifecycleCommandBus(): IdentityLifecycleCommandBus {
  return {
    async execute(command) {
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        userId: "user_jit_created",
        events: [],
      };
    },
  };
}

function createTokenVerifier(): TokenVerifier {
  return async (token) => ({
    workosUserId: session.user.id,
    workosOrgId: session.organizationId ?? null,
    sessionId: token === "refreshed-workos-access-token" ? "session_refreshed" : session.sessionId!,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}
