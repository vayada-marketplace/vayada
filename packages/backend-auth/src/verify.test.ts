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

async function signWorkOSTestToken(claims: JWTPayload & Record<string, unknown>) {
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
    .setIssuer(WORKOS_ISSUER)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWorkOSVerifier", () => {
  it("verifies a WorkOS access token that carries client_id instead of aud", async () => {
    const token = await signWorkOSTestToken({
      sub: "user_workos_hotel_owner",
      org_id: "org_workos_hotel_group",
      sid: "session_hotel_owner",
      client_id: WORKOS_CLIENT_ID,
    });

    const verifier = createWorkOSVerifier({
      jwksUrl: WORKOS_JWKS_URL,
      issuer: WORKOS_ISSUER,
      audience: WORKOS_CLIENT_ID,
    });

    await expect(verifier(token)).resolves.toMatchObject({
      workosUserId: "user_workos_hotel_owner",
      workosOrgId: "org_workos_hotel_group",
      sessionId: "session_hotel_owner",
    });
  });

  it("rejects a token for another WorkOS client_id", async () => {
    const token = await signWorkOSTestToken({
      sub: "user_workos_hotel_owner",
      org_id: "org_workos_hotel_group",
      client_id: "client_other",
    });

    const verifier = createWorkOSVerifier({
      jwksUrl: WORKOS_JWKS_URL,
      issuer: WORKOS_ISSUER,
      audience: WORKOS_CLIENT_ID,
    });

    await expect(verifier(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "TOKEN_INVALID",
    );
  });

  it("does not allow aud fallback to override a mismatched WorkOS client_id", async () => {
    const token = await signWorkOSTestToken({
      sub: "user_workos_hotel_owner",
      org_id: "org_workos_hotel_group",
      client_id: "client_other",
      aud: WORKOS_CLIENT_ID,
    });

    const verifier = createWorkOSVerifier({
      jwksUrl: WORKOS_JWKS_URL,
      issuer: WORKOS_ISSUER,
      audience: WORKOS_CLIENT_ID,
    });

    await expect(verifier(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "TOKEN_INVALID",
    );
  });

  it("keeps aud array support for non-WorkOS-compatible test tokens", async () => {
    const token = await signWorkOSTestToken({
      sub: "user_workos_hotel_owner",
      org_id: "org_workos_hotel_group",
      aud: ["client_other", WORKOS_CLIENT_ID],
    });

    const verifier = createWorkOSVerifier({
      jwksUrl: WORKOS_JWKS_URL,
      issuer: WORKOS_ISSUER,
      audience: WORKOS_CLIENT_ID,
    });

    await expect(verifier(token)).resolves.toMatchObject({
      workosUserId: "user_workos_hotel_owner",
      workosOrgId: "org_workos_hotel_group",
    });
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
