import { describe, expect, it } from "vitest";
import { GenericServerException, OauthException } from "@workos-inc/node";

import {
  AuthProviderUnavailableError,
  isWorkOSUnavailableError,
  mapWorkOSAuthError,
} from "./workosAuthState.js";

describe("mapWorkOSAuthError", () => {
  it("maps invalid credentials to a stable login error", () => {
    const error = Object.assign(new Error("raw provider message"), {
      code: "invalid_grant",
    });

    expect(mapWorkOSAuthError(error)).toEqual({
      state: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
  });

  it("maps email verification errors and keeps only UI-safe continuation fields", () => {
    expect(
      mapWorkOSAuthError({
        code: "email_verification_required",
        pending_authentication_token: "pending_123",
        email: "creator@example.test",
        email_verification_id: "email_verification_123",
        error_description: "provider text should not leak",
      }),
    ).toEqual({
      state: "email_verification_required",
      message: "Verify your email address to continue.",
      pendingAuthenticationToken: "pending_123",
      email: "creator@example.test",
      emailVerificationId: "email_verification_123",
    });
  });

  it("maps organization selection errors with workspace candidates", () => {
    expect(
      mapWorkOSAuthError({
        rawData: {
          code: "organization_selection_required",
          pending_authentication_token: "pending_workspace",
          organizations: [
            { id: "org_creator", name: "Creator Studio" },
            { organization_id: "org_hotel", name: "Hotel Group" },
          ],
        },
      }),
    ).toEqual({
      state: "organization_selection_required",
      message: "Choose a workspace to continue.",
      pendingAuthenticationToken: "pending_workspace",
      organizations: [
        { id: "org_creator", name: "Creator Studio" },
        { id: "org_hotel", name: "Hotel Group" },
      ],
    });
  });

  it("maps MFA enrollment and challenge errors to one app state", () => {
    expect(
      mapWorkOSAuthError({
        code: "mfa_challenge",
        pendingAuthenticationToken: "pending_mfa",
      }),
    ).toEqual({
      state: "mfa_required",
      message: "Additional verification is required.",
      pendingAuthenticationToken: "pending_mfa",
    });

    expect(mapWorkOSAuthError({ code: "mfa_enrollment" })).toEqual({
      state: "mfa_required",
      message: "Additional verification is required.",
    });

    expect(mapWorkOSAuthError({ code: "mfa_verification" })).toEqual({
      state: "mfa_required",
      message: "Additional verification is required.",
    });
  });

  it("maps SSO-required errors and connection ids", () => {
    expect(
      mapWorkOSAuthError({
        error: "sso_required",
        connection_ids: ["conn_123", "conn_456"],
      }),
    ).toEqual({
      state: "sso_required",
      message: "Single sign-on is required for this account.",
      connectionIds: ["conn_123", "conn_456"],
    });
  });

  it("maps unknown WorkOS failures to a generic app-owned failure state", () => {
    expect(
      mapWorkOSAuthError({
        code: "unexpected_workos_code",
        message: "raw provider message",
      }),
    ).toEqual({
      state: "auth_failed",
      message: "Authentication failed. Please try again.",
    });
  });
});

// VAY-2604: WorkOS being slow or down is "try again", everything else keeps its old meaning.
describe("isWorkOSUnavailableError", () => {
  const unavailable = "Signing in is taking longer than usual. Please try again in a moment.";

  it.each([
    [
      "the SDK's own timeout (408)",
      Object.assign(new Error("Request timeout after 4000ms"), {
        status: 408,
        error: "Request timeout",
      }),
    ],
    ["a rate limit (429)", Object.assign(new Error("Too many requests"), { status: 429 })],
    ["a WorkOS 5xx", Object.assign(new Error("Bad gateway"), { status: 502 })],
    ["a raw HTTP client error", { response: { status: 504 } }],
    ["fetch failing", new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })],
    ["an abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
    [
      "the session keys timing out",
      Object.assign(new Error("timed out"), { code: "ERR_JWKS_TIMEOUT" }),
    ],
    ["our own marker", new AuthProviderUnavailableError("timeout")],
  ])("treats %s as WorkOS being unavailable", (_name, error) => {
    expect(isWorkOSUnavailableError(error)).toBe(true);
    expect(mapWorkOSAuthError(error)).toEqual({ state: "auth_unavailable", message: unavailable });
  });

  // The shapes @workos-inc/node 10.10 really throws (review of VAY-2604).
  it.each([
    [
      "the SDK's timeout as an OauthException",
      new OauthException(408, "req_1", "Request timeout", undefined, { error: "Request timeout" }),
    ],
    [
      "a JSON 5xx as a GenericServerException",
      new GenericServerException(503, "Service unavailable", {}, "req_2"),
    ],
    [
      "an HTML 502 page the SDK could not parse, wrapped as 'Unexpected error'",
      new Error("Unexpected error: ParseError", {
        cause: Object.assign(new Error("Unexpected token <"), {
          name: "ParseError",
          rawStatus: 502,
        }),
      }),
    ],
    [
      "the session key set answering without a 200",
      Object.assign(new Error("Expected 200 OK from the JSON Web Key Set HTTP response"), {
        code: "ERR_JOSE_GENERIC",
      }),
    ],
  ])("treats %s as WorkOS being unavailable", (_name, error) => {
    expect(isWorkOSUnavailableError(error)).toBe(true);
    expect(mapWorkOSAuthError(error).state).toBe("auth_unavailable");
  });

  it("does not treat other jose errors or a wrapped bug as WorkOS being unavailable", () => {
    expect(
      isWorkOSUnavailableError(
        Object.assign(new Error("Invalid Compact JWS"), { code: "ERR_JOSE_GENERIC" }),
      ),
    ).toBe(false);
    expect(
      isWorkOSUnavailableError(
        new Error("Unexpected error: x", { cause: new TypeError("x is not a function") }),
      ),
    ).toBe(false);
  });

  it.each([
    ["a wrong password", { code: "invalid_credentials", status: 400 }],
    ["a bug in our code", new TypeError("Cannot read properties of undefined")],
    ["an unknown provider error", Object.assign(new Error("nope"), { status: 400 })],
    ["nothing useful", "boom"],
  ])("does not treat %s as WorkOS being unavailable", (_name, error) => {
    expect(isWorkOSUnavailableError(error)).toBe(false);
    expect(mapWorkOSAuthError(error).state).not.toBe("auth_unavailable");
  });

  it("keeps a known WorkOS answer even when it carries a 5xx-looking status", () => {
    expect(mapWorkOSAuthError({ code: "email_verification_required", status: 503 }).state).toBe(
      "email_verification_required",
    );
  });
});
