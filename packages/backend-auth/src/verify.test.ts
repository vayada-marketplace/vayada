import { describe, expect, it } from "vitest";

import { AuthError } from "./errors.js";
import { createFakeVerifier, extractBearerToken, type VerifiedSession } from "./verify.js";

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
