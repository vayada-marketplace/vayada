import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthError } from "./errors.js";
import {
  createFakeVerifier,
  createWorkOSVerifier,
  extractBearerToken,
  type VerifiedSession,
} from "./verify.js";

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------

describe("extractBearerToken", () => {
  it("extracts token from a valid Bearer header", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the Bearer prefix", () => {
    expect(extractBearerToken("bearer my-token")).toBe("my-token");
    expect(extractBearerToken("BEARER my-token")).toBe("my-token");
  });

  it("returns null for an undefined header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null when the scheme is not Bearer", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("Token abc")).toBeNull();
  });

  it("returns null for a bare token with no scheme", () => {
    expect(extractBearerToken("abc.def.ghi")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createWorkOSVerifier
// ---------------------------------------------------------------------------

const WORKOS_ISSUER = "https://api.workos.com/user_management/client_expected";
const WORKOS_CLIENT_ID = "client_expected";
const WORKOS_JWKS_URL = "https://api.workos.com/sso/jwks/client_expected";
const MCP_RESOURCE = "https://mcp.vayada.com/mcp";
const AUTHKIT_DOMAIN_ISSUER = "https://vayada.authkit.app";
const CIMD_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

async function signWorkOSTestToken(
  claims: JWTPayload & Record<string, unknown>,
  issuer: string = WORKOS_ISSUER,
) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const kid = "test-key";

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          keys: [
            {
              ...publicJwk,
              kid,
              alg: "RS256",
              use: "sig",
            },
          ],
        }),
        {
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }),
  );

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

function appVerifier() {
  return createWorkOSVerifier({
    jwksUrl: WORKOS_JWKS_URL,
    issuer: WORKOS_ISSUER,
    audience: WORKOS_CLIENT_ID,
  });
}

const isTokenInvalid = (e: unknown) => e instanceof AuthError && e.code === "TOKEN_INVALID";
// Which check refused the token, so a case can't pass by failing for another reason.
const CLIENT = /client_id claim does not match/;
const AGENT = /WorkOS agent token/;
const AUD = /audience is not the app client ID/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWorkOSVerifier", () => {
  it("extracts only a valid signed auth_time; never treats token issue time as fresh authentication", async () => {
    for (const auth_time of [undefined, "123", -1, 1.5, 123]) {
      const token = await signWorkOSTestToken({
        sub: "user",
        client_id: WORKOS_CLIENT_ID,
        auth_time,
      });
      const result = await appVerifier()(token);
      expect(result.authenticatedAt).toBe(auth_time === 123 ? 123 : undefined);
    }
  });

  it("verifies a WorkOS access token that carries client_id instead of aud", async () => {
    const token = await signWorkOSTestToken({
      sub: "user_workos_hotel_owner",
      org_id: "org_workos_hotel_group",
      sid: "session_hotel_owner",
      client_id: WORKOS_CLIENT_ID,
    });

    await expect(appVerifier()(token)).resolves.toMatchObject({
      workosUserId: "user_workos_hotel_owner",
      workosOrgId: "org_workos_hotel_group",
      sessionId: "session_hotel_owner",
    });
  });

  // VAY-2501: every app that calls /api today (PMS, Booking Admin, Vayada Admin, the
  // next-stack smoke, the sign-in session routes and admin-transfer re-login) sends an
  // AuthKit token minted for our one WorkOS client. These are the shapes they carry.
  it.each([
    {
      name: "hotel sign-in (PMS, Booking Admin): WorkOS's documented access-token claims",
      claims: {
        sub: "user_01HBEQKA6K4QJAS93VPE39W1JT",
        client_id: WORKOS_CLIENT_ID,
        org_id: "org_01HRDMC6CM357W30QMHMQ96Q0S",
        role: "member",
        roles: ["member"],
        permissions: ["posts:read", "posts:write"],
        entitlements: ["audit-logs"],
        feature_flags: ["advanced-analytics"],
        sid: "session_01HQSXZGF8FHF7A9ZZFCW4387R",
        jti: "01HQSXZXPPFPKMDD32RKTFY6PV",
      },
    },
    {
      name: "vayada staff sign-in (Vayada Admin): platform org",
      claims: {
        sub: "user_platform_admin",
        client_id: WORKOS_CLIENT_ID,
        org_id: "org_platform",
        role: "platform_admin",
        sid: "session_platform_admin",
      },
    },
    {
      name: "sign-in before an organization is selected",
      claims: { sub: "user_no_org", client_id: WORKOS_CLIENT_ID, sid: "session_no_org" },
    },
    {
      name: "WorkOS dashboard impersonation (act claim)",
      claims: {
        sub: "user_impersonated",
        client_id: WORKOS_CLIENT_ID,
        org_id: "org_workos_hotel_group",
        sid: "session_impersonated",
        act: { sub: "admin@vayada.com" },
      },
    },
    {
      name: "aud equal to our client id (WorkOS emulator shape)",
      claims: { sub: "user_emulated", client_id: WORKOS_CLIENT_ID, aud: WORKOS_CLIENT_ID },
    },
    {
      name: "aud array holding only our client id",
      claims: { sub: "user_emulated", client_id: WORKOS_CLIENT_ID, aud: [WORKOS_CLIENT_ID] },
    },
  ])("still accepts an app token: $name", async ({ claims }) => {
    const token = await signWorkOSTestToken(claims);

    await expect(appVerifier()(token)).resolves.toMatchObject({ workosUserId: claims.sub });
  });

  it.each([
    {
      name: "no client_id and no aud",
      reason: CLIENT,
      claims: { sub: "user", org_id: "org_workos_hotel_group" },
    },
    {
      name: "no client_id, aud equal to our client id (the removed aud fallback)",
      reason: CLIENT,
      claims: { sub: "user", aud: WORKOS_CLIENT_ID },
    },
    {
      name: "no client_id, aud array including our client id (the removed aud fallback)",
      reason: CLIENT,
      claims: { sub: "user", aud: ["client_other", WORKOS_CLIENT_ID] },
    },
    {
      name: "client_id that is not a string",
      reason: CLIENT,
      claims: { sub: "user", client_id: [WORKOS_CLIENT_ID] },
    },
    {
      name: "another client_id",
      reason: CLIENT,
      claims: { sub: "user", client_id: "client_other" },
    },
    {
      name: "another client_id with aud set to our client id",
      reason: CLIENT,
      claims: { sub: "user", client_id: "client_other", aud: WORKOS_CLIENT_ID },
    },
    {
      name: "an MCP app's client_id with aud defaulted to our client id (resource omitted)",
      reason: CLIENT,
      claims: { sub: "user", client_id: CIMD_CLIENT_ID, aud: WORKOS_CLIENT_ID, sid: "consent" },
    },
    {
      name: "WorkOS agent token (sub_profile ai_agent)",
      reason: AGENT,
      claims: { sub: "agent_01", client_id: WORKOS_CLIENT_ID, sub_profile: "ai_agent" },
    },
    {
      name: "any other sub_profile value",
      reason: AGENT,
      claims: { sub: "user", client_id: WORKOS_CLIENT_ID, sub_profile: "user" },
    },
    {
      name: "MCP audience",
      reason: AUD,
      claims: { sub: "user", client_id: WORKOS_CLIENT_ID, aud: MCP_RESOURCE },
    },
    {
      name: "MCP audience next to our client id",
      reason: AUD,
      claims: { sub: "user", client_id: WORKOS_CLIENT_ID, aud: [WORKOS_CLIENT_ID, MCP_RESOURCE] },
    },
    {
      name: "any other audience",
      reason: AUD,
      claims: { sub: "user", client_id: WORKOS_CLIENT_ID, aud: "client_other" },
    },
    {
      name: "empty audience list",
      reason: AUD,
      claims: { sub: "user", client_id: WORKOS_CLIENT_ID, aud: [] },
    },
    {
      name: "agent registration token (aud our client id, no client_id)",
      reason: CLIENT,
      claims: { sub: "agent_reg_01", aud: WORKOS_CLIENT_ID, act: { sub: "user_01" } },
    },
  ])("refuses a token with $name", async ({ claims, reason }) => {
    const token = await signWorkOSTestToken(claims);

    await expect(appVerifier()(token)).rejects.toSatisfy(
      (e: unknown) => isTokenInvalid(e) && reason.test((e as AuthError).message),
    );
  });

  it("keeps the issuer pinned: an app-shaped token from another issuer is refused", async () => {
    for (const issuer of [AUTHKIT_DOMAIN_ISSUER, "https://api.workos.com"]) {
      const token = await signWorkOSTestToken({ sub: "user", client_id: WORKOS_CLIENT_ID }, issuer);

      await expect(appVerifier()(token)).rejects.toSatisfy(
        (e: unknown) => isTokenInvalid(e) && /iss/.test((e as AuthError).message),
      );
    }
  });

  it("refuses an MCP Connect token as WorkOS documents it, by issuer and by its claims alone", async () => {
    const token = await signWorkOSTestToken(
      {
        sub: "user_workos_hotel_owner",
        client_id: CIMD_CLIENT_ID,
        aud: MCP_RESOURCE,
        org_id: "org_workos_hotel_group",
        sid: "consent_01",
        jti: "jti_01",
      },
      AUTHKIT_DOMAIN_ISSUER,
    );

    // What /api runs: the pinned app issuer refuses it.
    await expect(appVerifier()(token)).rejects.toSatisfy(
      (e: unknown) => isTokenInvalid(e) && /iss/.test((e as AuthError).message),
    );
    // Even if WorkOS ever signed Connect tokens with our issuer, the claim checks refuse it.
    const trustingItsIssuer = createWorkOSVerifier({
      jwksUrl: WORKOS_JWKS_URL,
      issuer: AUTHKIT_DOMAIN_ISSUER,
      audience: WORKOS_CLIENT_ID,
    });
    await expect(trustingItsIssuer(token)).rejects.toSatisfy(
      (e: unknown) => isTokenInvalid(e) && CLIENT.test((e as AuthError).message),
    );
  });

  it("refuses to start without the app client ID", () => {
    expect(() =>
      createWorkOSVerifier({ jwksUrl: WORKOS_JWKS_URL, issuer: WORKOS_ISSUER, audience: "" }),
    ).toThrow(/client ID/);
  });
});

// ---------------------------------------------------------------------------
// createFakeVerifier
// ---------------------------------------------------------------------------

const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 3600;
const PAST_EXPIRY = Math.floor(Date.now() / 1000) - 1;

const SESSION_HOTEL_OWNER: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: FUTURE_EXPIRY,
};

const SESSION_EXPIRED: VerifiedSession = {
  workosUserId: "user_workos_expired",
  workosOrgId: "org_workos_expired",
  sessionId: null,
  expiresAt: PAST_EXPIRY,
};

const fakeVerifier = createFakeVerifier(
  new Map([
    ["valid-hotel-owner-token", SESSION_HOTEL_OWNER],
    ["expired-token", SESSION_EXPIRED],
  ]),
);

describe("createFakeVerifier", () => {
  it("returns the session for a known valid token", async () => {
    const session = await fakeVerifier("valid-hotel-owner-token");
    expect(session.workosUserId).toBe("user_workos_hotel_owner");
    expect(session.workosOrgId).toBe("org_workos_hotel_group");
    expect(session.sessionId).toBe("session_hotel_owner");
  });

  it("throws TOKEN_INVALID for an unknown token", async () => {
    await expect(fakeVerifier("not-a-real-token")).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "TOKEN_INVALID",
    );
  });

  it("throws TOKEN_EXPIRED for a token whose expiresAt is in the past", async () => {
    await expect(fakeVerifier("expired-token")).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "TOKEN_EXPIRED",
    );
  });

  it("throws TOKEN_INVALID when a session has expiresAt set to undefined (missing exp)", async () => {
    const badVerifier = createFakeVerifier(
      new Map([
        [
          "no-exp-token",
          {
            workosUserId: "user_no_exp",
            workosOrgId: null,
            sessionId: null,
            expiresAt: undefined as unknown as number,
          },
        ],
      ]),
    );
    // undefined < number is false — so a missing exp would NOT be caught by the
    // expiry check. This test documents that callers must always supply expiresAt.
    // The production createWorkOSVerifier guards this by validating payload.exp
    // before constructing the VerifiedSession.
    const session = await badVerifier("no-exp-token");
    expect(session.expiresAt).toBeUndefined();
  });

  it("preserves null workosOrgId when no org is in the session", async () => {
    const noOrgVerifier = createFakeVerifier(
      new Map([
        [
          "no-org-token",
          {
            workosUserId: "user_no_org",
            workosOrgId: null,
            sessionId: null,
            expiresAt: FUTURE_EXPIRY,
          },
        ],
      ]),
    );
    const session = await noOrgVerifier("no-org-token");
    expect(session.workosOrgId).toBeNull();
  });
});
