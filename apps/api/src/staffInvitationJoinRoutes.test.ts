import type {
  IdentityLifecycleCommandBus,
  IdentityRepository,
  StaffInvitationAcceptanceEvent,
  StaffInvitationAcceptanceResult,
  StaffInvitationJoinDetails,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type {
  AuthKitClient,
  AuthKitInvitation,
  AuthKitSession,
  ProductAuditEvent,
} from "./routes/authSession.js";

const PMS_ORIGIN = "https://pms.localhost";
const WORKOS_ORG = "org_workos_alpenrose";
const TOKEN = "invitation-token-from-email";

const pendingInvitation: AuthKitInvitation = {
  id: "invitation_alpenrose",
  email: "Maria.Huber@example.com",
  state: "pending",
  organizationId: WORKOS_ORG,
  acceptedUserId: null,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

const details: StaffInvitationJoinDetails = {
  email: "maria.huber@example.com",
  inviteeName: "Maria Huber",
  inviterName: "Anna Keller",
  roleKey: "front_desk",
  roleName: "Reservation manager",
  hotelNames: ["Hotel Alpenrose"],
};

const activeAccount = {
  id: "user_workos_maria",
  email: "maria.huber@example.com",
  emailVerified: true,
  lastSignInAt: "2026-10-01T08:00:00.000Z",
  externalId: "user_maria",
  signupFlow: null,
  createdAt: "2026-09-01T08:00:00.000Z",
};

// What WorkOS creates for a new address when the invitation is sent: same creation time.
const INVITED_AT = "2026-10-20T09:00:00.000Z";
const placeholderUser = {
  id: "user_workos_placeholder",
  email: "maria.huber@example.com",
  emailVerified: false,
  lastSignInAt: null,
  externalId: null,
  signupFlow: null,
  createdAt: INVITED_AT,
};

const joinedSession: AuthKitSession = {
  accessToken: "invitee-access-token",
  sealedSession: "invitee-sealed-session",
  sessionId: "session_invitee",
  organizationId: WORKOS_ORG,
  user: {
    id: "user_workos_maria",
    email: "maria.huber@example.com",
    emailVerified: true,
    name: "Maria Huber",
  },
};

describe("staff invitation join routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("previews the invitation with the hotel name and whether the address has an account", async () => {
    const findCurrent = vi.fn(async () => details);
    const findUserByEmail = vi.fn(async () => null);
    app = buildJoinApp({ authKit: { findUserByEmail }, findCurrent });

    const response = await post(app, "/auth/invitations/preview", {
      surface: "pms-web",
      invitationToken: TOKEN,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      state: "invitation_ready",
      email: "maria.huber@example.com",
      accountExists: false,
      hotelNames: ["Hotel Alpenrose"],
      inviterName: "Anna Keller",
      inviteeName: "Maria Huber",
      roleKey: "front_desk",
      roleName: "Reservation manager",
    });
    expect(findCurrent).toHaveBeenCalledWith({
      providerInvitationId: "invitation_alpenrose",
      workosOrganizationId: WORKOS_ORG,
    });
    expect(findUserByEmail).toHaveBeenCalledWith({ email: "maria.huber@example.com" });
  });

  it.each([
    ["an unknown token", { throws: 404 }, "invalid"],
    ["an accepted invitation", { state: "accepted" }, "accepted"],
    ["a revoked invitation", { state: "revoked" }, "revoked"],
    ["an expired invitation", { state: "expired" }, "expired"],
    ["a pending invitation past its expiry", { expiresAt: "2020-01-01T00:00:00.000Z" }, "expired"],
    ["an invitation Vayada replaced", { current: null }, "replaced"],
    [
      "an invitation for another address",
      { current: { ...details, email: "x@example.com" } },
      "invalid",
    ],
  ] as const)("answers 410 for %s", async (_label, variant, reason) => {
    const findCurrent = vi.fn(async () => ("current" in variant ? variant.current : details));
    app = buildJoinApp({
      authKit: {
        async findInvitationByToken() {
          if ("throws" in variant) {
            throw Object.assign(new Error("Not found"), { status: variant.throws });
          }
          return { ...pendingInvitation, ...variant } as AuthKitInvitation;
        },
      },
      findCurrent,
    });

    const response = await post(app, "/auth/invitations/preview", {
      surface: "pms-web",
      invitationToken: TOKEN,
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ state: "invitation_unavailable", reason });
  });

  it("rejects foreign origins and other surfaces before calling WorkOS", async () => {
    const findInvitationByToken = vi.fn(async () => pendingInvitation);
    app = buildJoinApp({ authKit: { findInvitationByToken } });

    const foreign = await post(
      app,
      "/auth/invitations/preview",
      { surface: "pms-web", invitationToken: TOKEN },
      "https://evil.example",
    );
    const otherSurface = await post(app, "/auth/invitations/preview", {
      surface: "booking-admin",
      invitationToken: TOKEN,
    });

    expect(foreign.statusCode).toBe(403);
    expect(otherSurface.statusCode).toBe(400);
    expect(findInvitationByToken).not.toHaveBeenCalled();
  });

  it("creates a verified account for a new address, joins the hotel and signs the invitee in", async () => {
    const createUser = vi.fn(async () => joinedSession.user);
    const authenticateWithPassword = vi.fn(async () => joinedSession);
    const updateUserExternalId = vi.fn(async () => {});
    const reconcile = vi.fn(
      async (event: StaffInvitationAcceptanceEvent): Promise<StaffInvitationAcceptanceResult> => ({
        outcome: "accepted",
        invitationId: "local-invitation",
        membershipId: `membership_for_${event.providerUserId}`,
      }),
    );
    const userByProviderUserId = vi
      .fn<IdentityRepository["findUserByProviderUserId"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ userId: "user_maria", email: details.email, status: "active" });
    const audits: ProductAuditEvent[] = [];
    app = buildJoinApp({
      authKit: {
        findUserByEmail: async () => null,
        createUser,
        authenticateWithPassword,
        updateUserExternalId,
      },
      reconcile,
      userByProviderUserId,
      audits,
    });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      email: "attacker@example.com",
      name: "  Maria   von Huber ",
      password: "long enough password",
    });

    expect(response.statusCode).toBe(200);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "maria.huber@example.com",
        password: "long enough password",
        firstName: "Maria",
        lastName: "von Huber",
        emailVerified: true,
        metadata: { auth_flow: "invitation", surface: "pms-web" },
      }),
    );
    expect(authenticateWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "maria.huber@example.com",
        password: "long enough password",
        invitationToken: TOKEN,
      }),
    );
    expect(updateUserExternalId).toHaveBeenCalledWith({
      workosUserId: "user_workos_maria",
      externalId: "user_maria",
    });
    expect(reconcile).toHaveBeenCalledWith({
      providerEventId: "vayada-invite-accept:invitation_alpenrose",
      providerInvitationId: "invitation_alpenrose",
      providerUserId: "user_workos_maria",
      providerOrganizationId: WORKOS_ORG,
      invitationEmail: "maria.huber@example.com",
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=invitee-sealed-session"),
        expect.stringContaining(`vayada_pms_selected_org=${WORKOS_ORG}`),
      ]),
    );
    expect(response.json()).toMatchObject({
      organizationId: "org_alpenrose",
      workosOrganizationId: WORKOS_ORG,
      organizationKind: "hotel_group",
      user: { id: "user_maria" },
    });
    expect(response.json().organizationSelectionRequired).toBeUndefined();
    expect(audits).toEqual([
      expect.objectContaining({ action: "auth.login", authFlow: "signup", surface: "pms-web" }),
    ]);
  });

  it("signs an existing account in with the invitation instead of creating one", async () => {
    const createUser = vi.fn(async () => joinedSession.user);
    const reconcile = vi.fn(async () => ({
      outcome: "idempotent_replay" as const,
      invitationId: "local-invitation",
      membershipId: "membership_maria",
    }));
    app = buildJoinApp({ authKit: { createUser }, reconcile });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      password: "existing password",
    });

    expect(response.statusCode).toBe(200);
    expect(createUser).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("sets up the never-used user WorkOS created with the invitation instead of a second account", async () => {
    const createUser = vi.fn(async () => joinedSession.user);
    const activateInvitedUser = vi.fn(async () => {});
    const findUserByEmail = vi.fn(async () => placeholderUser);
    const calls: string[] = [];
    app = buildJoinApp({
      authKit: {
        findUserByEmail,
        createUser,
        activateInvitedUser,
        authenticateWithPassword: async () => {
          calls.push("sign-in");
          return joinedSession;
        },
      },
      markProviderEmailVerified: async (input) => {
        calls.push(`verified:${input.workosUserId}`);
      },
    });

    const preview = await post(app, "/auth/invitations/preview", {
      surface: "pms-web",
      invitationToken: TOKEN,
    });
    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      name: "Maria Huber",
      password: "long enough password",
    });

    expect(preview.json()).toMatchObject({ accountExists: false });
    expect(response.statusCode).toBe(200);
    expect(createUser).not.toHaveBeenCalled();
    expect(activateInvitedUser).toHaveBeenCalledWith({
      userId: "user_workos_placeholder",
      password: "long enough password",
      firstName: "Maria",
      lastName: "Huber",
    });
    // The stored identity is verified before WorkOS accepts, for a webhook that arrives first.
    expect(calls.slice(0, 2)).toEqual(["verified:user_workos_placeholder", "sign-in"]);
  });

  it.each([
    ["has signed in before", { lastSignInAt: "2026-09-01T10:00:00.000Z" }],
    ["signed up in Vayada with a password", { signupFlow: "signup" }],
    ["was linked to a Vayada user", { externalId: "user_other" }],
    ["is registered under another address", { email: "someone.else@example.com" }],
    ["no invitation created (it predates them)", { createdAt: "2026-08-01T09:00:00.000Z" }],
  ] as const)(
    "never sets a password for an unverified user that %s; it must log in",
    async (_label, variant) => {
      const activateInvitedUser = vi.fn(async () => {});
      const createUser = vi.fn(async () => joinedSession.user);
      const authenticateWithPassword = vi.fn(async () => joinedSession);
      const user = { ...placeholderUser, ...variant };
      app = buildJoinApp({
        authKit: {
          findUserByEmail: async () => user,
          activateInvitedUser,
          createUser,
          authenticateWithPassword,
        },
      });

      const preview = await post(app, "/auth/invitations/preview", {
        surface: "pms-web",
        invitationToken: TOKEN,
      });
      const response = await post(app, "/auth/invitations/accept", {
        surface: "pms-web",
        invitationToken: TOKEN,
        name: "Maria Huber",
        password: "a guessed password",
      });

      expect(preview.json()).toMatchObject({ accountExists: true });
      expect(response.statusCode).toBe(200);
      expect(activateInvitedUser).not.toHaveBeenCalled();
      expect(createUser).not.toHaveBeenCalled();
      expect(authenticateWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({ password: "a guessed password", invitationToken: TOKEN }),
      );
    },
  );

  it.each([
    ["an unknown token", { throws: 404 }],
    ["a revoked invitation", { state: "revoked" }],
    ["an expired invitation", { state: "expired" }],
    ["an invitation Vayada replaced", { current: null }],
    ["an invitation for another address", { current: { ...details, email: "x@example.com" } }],
  ] as const)("never creates or sets up an account for %s", async (_label, variant) => {
    const activateInvitedUser = vi.fn(async () => {});
    const createUser = vi.fn(async () => joinedSession.user);
    const authenticateWithPassword = vi.fn(async () => joinedSession);
    app = buildJoinApp({
      authKit: {
        async findInvitationByToken() {
          if ("throws" in variant) {
            throw Object.assign(new Error("Not found"), { status: variant.throws });
          }
          return { ...pendingInvitation, ...variant } as AuthKitInvitation;
        },
        findUserByEmail: async () => placeholderUser,
        activateInvitedUser,
        createUser,
        authenticateWithPassword,
      },
      findCurrent: async () => ("current" in variant ? variant.current : details),
    });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      name: "Maria Huber",
      password: "long enough password",
    });

    expect(response.statusCode).toBe(410);
    expect(activateInvitedUser).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(authenticateWithPassword).not.toHaveBeenCalled();
  });

  it("marks an existing identity verified before reconciling, as WorkOS just confirmed it", async () => {
    const calls: string[] = [];
    app = buildJoinApp({
      markProviderEmailVerified: async (input) => {
        calls.push(`verified:${input.workosUserId}:${input.email}`);
      },
      reconcile: async () => {
        calls.push("reconcile");
        return { outcome: "accepted", invitationId: "local", membershipId: "membership_maria" };
      },
    });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      password: "existing password",
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(["verified:user_workos_maria:maria.huber@example.com", "reconcile"]);
  });

  it("asks a new address for a name before creating anything", async () => {
    const createUser = vi.fn(async () => joinedSession.user);
    app = buildJoinApp({ authKit: { findUserByEmail: async () => null, createUser } });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      password: "long enough password",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "name_required" });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("explains a weak password without signing in", async () => {
    const authenticateWithPassword = vi.fn(async () => joinedSession);
    app = buildJoinApp({
      authKit: {
        findUserByEmail: async () => null,
        async createUser() {
          throw Object.assign(new Error("weak"), { status: 422, code: "password_strength_error" });
        },
        authenticateWithPassword,
      },
    });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      name: "Maria Huber",
      password: "password",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "password_too_weak" });
    expect(authenticateWithPassword).not.toHaveBeenCalled();
  });

  it("falls back to signing in when the address was registered in the meantime", async () => {
    const authenticateWithPassword = vi.fn(async () => joinedSession);
    app = buildJoinApp({
      authKit: {
        findUserByEmail: async () => null,
        async createUser() {
          throw Object.assign(new Error("taken"), {
            status: 400,
            code: "user_creation_error",
            errors: [{ code: "email_not_available" }],
          });
        },
        authenticateWithPassword,
      },
    });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      name: "Maria Huber",
      password: "long enough password",
    });

    expect(response.statusCode).toBe(200);
    expect(authenticateWithPassword).toHaveBeenCalledOnce();
  });

  it("returns a wrong password without a session or a pending WorkOS token", async () => {
    const reconcile = vi.fn();
    const audits: ProductAuditEvent[] = [];
    app = buildJoinApp({
      authKit: {
        async authenticateWithPassword() {
          throw { code: "invalid_credentials", pending_authentication_token: "pending-token" };
        },
      },
      reconcile,
      audits,
    });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      password: "wrong password",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      state: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({
        action: "auth.login.failed",
        failureReason: "invalid_credentials",
      }),
    ]);
  });

  it.each([
    ["WorkOS did not accept the invitation", { invitation: { state: "pending" } }],
    ["WorkOS accepted it for another user", { invitation: { acceptedUserId: "user_other" } }],
    ["the session is for another organization", { sessionOrg: "org_workos_other" }],
    [
      "the reconciler rejects the acceptance",
      { reconciled: { outcome: "rejected", reason: "invitation_access_invalid" } },
    ],
  ] as const)("sets no session when %s", async (_label, variant) => {
    const reconcile = vi.fn(async () =>
      "reconciled" in variant
        ? (variant.reconciled as StaffInvitationAcceptanceResult)
        : { outcome: "accepted" as const, invitationId: "local", membershipId: "membership" },
    );
    app = buildJoinApp({
      authKit: {
        async authenticateWithPassword() {
          return "sessionOrg" in variant
            ? { ...joinedSession, organizationId: variant.sessionOrg }
            : joinedSession;
        },
        async getInvitation() {
          return {
            ...pendingInvitation,
            state: "accepted",
            acceptedUserId: joinedSession.user.id,
            ...("invitation" in variant ? variant.invitation : {}),
          } as AuthKitInvitation;
        },
      },
      reconcile,
    });

    const response = await post(app, "/auth/invitations/accept", {
      surface: "pms-web",
      invitationToken: TOKEN,
      password: "existing password",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "invitation_not_joined" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    if (!("reconciled" in variant)) expect(reconcile).not.toHaveBeenCalled();
  });
});

function post(
  app: ReturnType<typeof buildApp>,
  url: string,
  payload: Record<string, unknown>,
  origin = PMS_ORIGIN,
) {
  return app.inject({ method: "POST", url, headers: { origin }, payload });
}

function buildJoinApp(input: {
  authKit?: Partial<AuthKitClient>;
  findCurrent?: () => Promise<StaffInvitationJoinDetails | null>;
  markProviderEmailVerified?: (input: { workosUserId: string; email: string }) => Promise<void>;
  reconcile?: (event: StaffInvitationAcceptanceEvent) => Promise<StaffInvitationAcceptanceResult>;
  userByProviderUserId?: IdentityRepository["findUserByProviderUserId"];
  audits?: ProductAuditEvent[];
}) {
  const authKitClient = {
    findInvitationByToken: async () => pendingInvitation,
    getInvitation: async () => ({
      ...pendingInvitation,
      state: "accepted" as const,
      acceptedUserId: joinedSession.user.id,
    }),
    findUserByEmail: async () => activeAccount,
    authenticateWithPassword: async () => joinedSession,
    updateUserExternalId: async () => {},
    listInvitationCreatedAts: async () => [INVITED_AT],
    ...input.authKit,
  } as AuthKitClient;
  const identityRepository: IdentityRepository = {
    findUserByProviderUserId:
      input.userByProviderUserId ??
      (async () => ({ userId: "user_maria", email: details.email, status: "active" })),
    findOrganizationByWorkosOrgId: async (workosOrgId) =>
      workosOrgId === WORKOS_ORG
        ? {
            organizationId: "org_alpenrose",
            workosOrgId: WORKOS_ORG,
            name: "Info Hotel Group",
            kind: "hotel_group",
            status: "active",
          }
        : null,
    findActiveMembership: async () => ({
      membershipId: "membership_maria",
      status: "active",
      roleKey: "front_desk",
      workosMembershipId: "om_maria",
      workosRoleSlugs: ["hotel_member"],
    }),
    listMembershipOrganizations: async () => [],
    findLinkedResources: async () => [],
  };
  const lifecycleCommandBus: IdentityLifecycleCommandBus = {
    async execute(command) {
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        userId: "user_maria",
        events: [],
      };
    },
  };
  return buildApp({
    logger: false,
    authSession: {
      authKitClient,
      identityRepository,
      lifecycleCommandBus,
      productAuditSink: {
        async record(event) {
          input.audits?.push(event);
        },
      },
      tokenVerifier: async () => {
        throw new Error("not used");
      },
      logoutReturnUrl: `${PMS_ORIGIN}/login`,
      allowedOrigins: [PMS_ORIGIN],
      compatibilityCallbackOrigin: "https://api.localhost",
      requiredOrganizationKind: "platform",
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: `${PMS_ORIGIN}/login`,
          requireExplicitOrganizationSelection: true,
          selectedOrganizationCookieName: "vayada_pms_selected_org",
          requiredResourceLink: { product: "pms", resourceType: "pms_property" },
        },
      },
      oauthStateSecret: "test-oauth-state-secret",
      cookieSecure: false,
      propertyAccessRepository: {
        async findMembershipPropertyScope(context) {
          return {
            mode: "all",
            roleKey: context.membership.roleKey,
            accessOrigin: "agency",
            assignedPropertyIds: [],
          };
        },
      },
      staffInvitationJoin: {
        repository: {
          findCurrent: input.findCurrent ?? (async () => details),
          markProviderEmailVerified: input.markProviderEmailVerified ?? (async () => {}),
        },
        acceptance: {
          reconcile:
            input.reconcile ??
            (async () => ({
              outcome: "accepted",
              invitationId: "local-invitation",
              membershipId: "membership_maria",
            })),
        },
      },
    },
  });
}
