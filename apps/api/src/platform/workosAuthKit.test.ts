import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWorkOSAuthKitClient,
  WORKOS_SIGN_IN_MAX_RETRIES,
  WORKOS_SIGN_IN_TIMEOUT_MS,
} from "./workosAuthKit.js";
import { AuthProviderUnavailableError } from "./workosAuthState.js";

const workosMocks = vi.hoisted(() => ({
  WorkOS: vi.fn(),
  authenticate: vi.fn(),
  authenticateWithOrganizationSelection: vi.fn(),
  loadSealedSession: vi.fn(),
  listSessions: vi.fn(),
  refresh: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@workos-inc/node", () => ({
  WorkOS: workosMocks.WorkOS,
}));

describe("createWorkOSAuthKitClient", () => {
  beforeEach(() => {
    workosMocks.WorkOS.mockReset();
    workosMocks.authenticate.mockReset();
    workosMocks.authenticateWithOrganizationSelection.mockReset();
    workosMocks.loadSealedSession.mockReset();
    workosMocks.listSessions.mockReset();
    workosMocks.refresh.mockReset();
    workosMocks.updateUser.mockReset();
  });

  it("seals the session after selecting a WorkOS organization", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          authenticateWithOrganizationSelection: workosMocks.authenticateWithOrganizationSelection,
        },
      };
    });
    workosMocks.authenticateWithOrganizationSelection.mockResolvedValue({
      accessToken: "platform-access-token",
      organizationId: "org_workos_platform",
      sealedSession: "platform-sealed-session",
      sessionId: "session_platform",
      user: {
        id: "user_workos_platform",
        email: "admin@example.com",
        emailVerified: true,
      },
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateWithOrganizationSelection({
        organizationId: "org_workos_platform",
        pendingAuthenticationToken: "pending_platform_selection",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      }),
    ).resolves.toMatchObject({
      organizationId: "org_workos_platform",
      sealedSession: "platform-sealed-session",
    });
    expect(workosMocks.authenticateWithOrganizationSelection).toHaveBeenCalledWith({
      organizationId: "org_workos_platform",
      pendingAuthenticationToken: "pending_platform_selection",
      clientId: "client_test",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      session: {
        sealSession: true,
        cookiePassword: "a".repeat(32),
      },
    });
  });

  it("preserves the selected organization returned by WorkOS refresh", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
      refresh: workosMocks.refresh,
    });
    workosMocks.refresh.mockResolvedValue({
      authenticated: true,
      accessToken: "refreshed-access-token",
      organizationId: "org_workos_hotel",
      sealedSession: "refreshed-sealed-session",
      session: {
        accessToken: "nested-access-token",
        refreshToken: "refresh-token",
        user: {
          id: "nested_user",
          email: "nested@example.test",
          emailVerified: false,
          name: "Nested User",
        },
      },
      user: {
        id: "user_workos_hotel",
        email: "hotel@example.com",
        emailVerified: true,
        name: "Hotel Owner",
      },
      sessionId: "session_refreshed",
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.refreshSession({
        sealedSession: "sealed-session",
        organizationId: "org_workos_hotel",
      }),
    ).resolves.toMatchObject({
      accessToken: "refreshed-access-token",
      organizationId: "org_workos_hotel",
      sealedSession: "refreshed-sealed-session",
      sessionId: "session_refreshed",
      user: {
        id: "user_workos_hotel",
      },
    });
    expect(workosMocks.refresh).toHaveBeenCalledWith({
      cookiePassword: "a".repeat(32),
      organizationId: "org_workos_hotel",
    });
    expect(workosMocks.authenticate).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token while restoring a sealed browser session", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
      refresh: workosMocks.refresh,
    });
    workosMocks.authenticate.mockResolvedValue({
      authenticated: false,
      reason: "invalid_jwt",
    });
    workosMocks.refresh.mockResolvedValue({
      authenticated: true,
      accessToken: "refreshed-access-token",
      sealedSession: "refreshed-sealed-session",
      session: { accessToken: "nested-access-token" },
      user: {
        id: "user_workos_creator",
        email: "creator@example.com",
        emailVerified: true,
        name: "Creator",
      },
      sessionId: "session_refreshed",
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateSession({ sealedSession: "expired-access-token-session" }),
    ).resolves.toMatchObject({
      accessToken: "refreshed-access-token",
      sealedSession: "refreshed-sealed-session",
      sessionId: "session_refreshed",
      user: { id: "user_workos_creator" },
    });
    expect(workosMocks.refresh).toHaveBeenCalledWith({
      cookiePassword: "a".repeat(32),
      organizationId: undefined,
    });
  });

  it.each([
    ["name", { name: "JWTExpired" }],
    ["code", { code: "ERR_JWT_EXPIRED" }],
  ])(
    "refreshes when sealed-session authentication throws an expired-token error identified by %s",
    async (_discriminator, errorShape) => {
      workosMocks.WorkOS.mockImplementation(function WorkOS() {
        return {
          userManagement: {
            loadSealedSession: workosMocks.loadSealedSession,
          },
        };
      });
      workosMocks.loadSealedSession.mockReturnValue({
        authenticate: workosMocks.authenticate,
        refresh: workosMocks.refresh,
      });
      const error = Object.assign(new Error("JWT expired"), errorShape);
      workosMocks.authenticate.mockRejectedValue(error);
      workosMocks.refresh.mockResolvedValue({
        authenticated: true,
        accessToken: "refreshed-access-token",
        sealedSession: "refreshed-sealed-session",
        session: { accessToken: "nested-access-token" },
        user: {
          id: "user_workos_creator",
          email: "creator@example.com",
          emailVerified: true,
          name: "Creator",
        },
        sessionId: "session_refreshed",
      });

      const client = createWorkOSAuthKitClient({
        apiKey: "sk_test",
        clientId: "client_test",
        cookiePassword: "a".repeat(32),
      });

      await expect(
        client.authenticateSession({ sealedSession: "expired-access-token-session" }),
      ).resolves.toMatchObject({
        accessToken: "refreshed-access-token",
        sealedSession: "refreshed-sealed-session",
        sessionId: "session_refreshed",
      });
      expect(workosMocks.refresh).toHaveBeenCalledWith({
        cookiePassword: "a".repeat(32),
        organizationId: undefined,
      });
    },
  );

  it("does not refresh an invalid sealed-session cookie", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
      refresh: workosMocks.refresh,
    });
    workosMocks.authenticate.mockResolvedValue({
      authenticated: false,
      reason: "invalid_session_cookie",
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateSession({ sealedSession: "invalid-session" }),
    ).resolves.toBeNull();
    expect(workosMocks.refresh).not.toHaveBeenCalled();
  });

  it("treats stale sealed-session JWKS mismatches as invalid sessions", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
    });
    const error = new Error("no applicable key found in the JSON Web Key Set");
    Object.defineProperty(error, "name", { value: "JWKSNoMatchingKey" });
    Object.assign(error, { code: "ERR_JWKS_NO_MATCHING_KEY" });
    workosMocks.authenticate.mockRejectedValue(error);

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateSession({ sealedSession: "stale-session" }),
    ).resolves.toBeNull();
    expect(workosMocks.refresh).not.toHaveBeenCalled();
  });

  it("checks the provider session before issuing a cross-app handoff", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          listSessions: workosMocks.listSessions,
        },
      };
    });
    workosMocks.listSessions.mockImplementation(async (_userId, options) =>
      options?.after === "next-page"
        ? {
            data: [{ id: "session_revoked", status: "revoked" }],
            listMetadata: {},
          }
        : {
            data: [{ id: "session_active", status: "active" }],
            listMetadata: { after: "next-page" },
          },
    );

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.isSessionActive({
        sessionId: "session_active",
        workosUserId: "user_workos_hotel",
      }),
    ).resolves.toBe(true);
    await expect(
      client.isSessionActive({
        sessionId: "session_revoked",
        workosUserId: "user_workos_hotel",
      }),
    ).resolves.toBe(false);
    expect(workosMocks.listSessions).toHaveBeenCalledWith("user_workos_hotel", { limit: 100 });
    expect(workosMocks.listSessions).toHaveBeenCalledWith("user_workos_hotel", {
      after: "next-page",
      limit: 100,
    });
    expect(workosMocks.listSessions).toHaveBeenCalledTimes(3);
  });

  it("rethrows unclassified sealed-session errors without refreshing", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
      refresh: workosMocks.refresh,
    });
    const error = new Error("WorkOS unavailable");
    workosMocks.authenticate.mockRejectedValue(error);

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(client.authenticateSession({ sealedSession: "valid-session" })).rejects.toBe(
      error,
    );
    expect(workosMocks.refresh).not.toHaveBeenCalled();
  });

  it("treats expired sealed-session refreshes as invalid sessions", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          loadSealedSession: workosMocks.loadSealedSession,
        },
      };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      refresh: workosMocks.refresh,
    });
    workosMocks.refresh.mockRejectedValue(
      Object.assign(new Error("JWT expired"), { code: "ERR_JWT_EXPIRED" }),
    );

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(client.refreshSession({ sealedSession: "stale-session" })).resolves.toBeNull();
  });

  // VAY-2604: a slow WorkOS must answer "try again" quickly and never end a session.
  it("gives sign-in and session calls a short timeout and keeps account writes on the SDK defaults", async () => {
    const clients: Array<{ options: unknown; userManagement: Record<string, unknown> }> = [];
    workosMocks.WorkOS.mockImplementation(function WorkOS(_apiKey: string, options: unknown) {
      const client = {
        options,
        userManagement: {
          authenticateWithPassword: vi.fn(async () => {
            throw new Error("stop here");
          }),
          createPasswordReset: vi.fn(async () => undefined),
        },
      };
      clients.push(client);
      return client;
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    expect(clients.map(({ options }) => options)).toEqual([
      { clientId: "client_test" },
      {
        clientId: "client_test",
        timeout: WORKOS_SIGN_IN_TIMEOUT_MS,
        maxRetries: WORKOS_SIGN_IN_MAX_RETRIES,
      },
    ]);
    const [writes, signIn] = clients;
    await expect(
      client.authenticateWithPassword({ email: "a@example.test", password: "secret" }),
    ).rejects.toThrow("stop here");
    expect(signIn!.userManagement.authenticateWithPassword).toHaveBeenCalledOnce();
    expect(writes!.userManagement.authenticateWithPassword).not.toHaveBeenCalled();
    await client.createPasswordReset({ email: "a@example.test" });
    expect(writes!.userManagement.createPasswordReset).toHaveBeenCalledOnce();
    expect(signIn!.userManagement.createPasswordReset).not.toHaveBeenCalled();
    // One call with its one retry (SDK backoff at most ~1.7 s) still answers inside the PMS gateway's 10 s.
    expect(WORKOS_SIGN_IN_TIMEOUT_MS * (WORKOS_SIGN_IN_MAX_RETRIES + 1) + 1_700).toBeLessThan(
      10_000,
    );
  });

  it.each(["timeout", "server_error", "network_error", "rate_limit_exceeded"] as const)(
    "keeps the session when WorkOS refresh fails with retryable %s",
    async (reason) => {
      workosMocks.WorkOS.mockImplementation(function WorkOS() {
        return { userManagement: { loadSealedSession: workosMocks.loadSealedSession } };
      });
      workosMocks.loadSealedSession.mockReturnValue({ refresh: workosMocks.refresh });
      workosMocks.refresh.mockResolvedValue({ authenticated: false, reason, retryable: true });

      const client = createWorkOSAuthKitClient({
        apiKey: "sk_test",
        clientId: "client_test",
        cookiePassword: "a".repeat(32),
      });

      await expect(client.refreshSession({ sealedSession: "live-session" })).rejects.toMatchObject({
        name: "AuthProviderUnavailableError",
        reason,
      });
    },
  );

  it("still ends a session WorkOS says is over", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return { userManagement: { loadSealedSession: workosMocks.loadSealedSession } };
    });
    workosMocks.loadSealedSession.mockReturnValue({ refresh: workosMocks.refresh });
    workosMocks.refresh.mockResolvedValue({
      authenticated: false,
      reason: "invalid_grant",
      retryable: false,
    });

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(client.refreshSession({ sealedSession: "ended-session" })).resolves.toBeNull();
  });

  it("reports WorkOS as unavailable when its signing keys time out", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return { userManagement: { loadSealedSession: workosMocks.loadSealedSession } };
    });
    workosMocks.loadSealedSession.mockReturnValue({
      authenticate: workosMocks.authenticate,
      refresh: workosMocks.refresh,
    });
    workosMocks.authenticate.mockRejectedValue(
      Object.assign(new Error("request timed out"), { code: "ERR_JWKS_TIMEOUT" }),
    );

    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await expect(
      client.authenticateSession({ sealedSession: "live-session" }),
    ).rejects.toBeInstanceOf(AuthProviderUnavailableError);
    expect(workosMocks.refresh).not.toHaveBeenCalled();
  });

  it("updates both structured and display names", async () => {
    workosMocks.WorkOS.mockImplementation(function WorkOS() {
      return {
        userManagement: {
          updateUser: workosMocks.updateUser,
        },
      };
    });
    workosMocks.updateUser.mockResolvedValue({});
    const client = createWorkOSAuthKitClient({
      apiKey: "sk_test",
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
    });

    await client.updateUserName({
      workosUserId: "user_workos_hotel",
      firstName: "Mary Jane",
      lastName: "Watson",
    });

    expect(workosMocks.updateUser).toHaveBeenCalledWith({
      userId: "user_workos_hotel",
      name: "Mary Jane Watson",
      firstName: "Mary Jane",
      lastName: "Watson",
    });
  });
});
