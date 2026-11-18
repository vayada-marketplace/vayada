import { createRemoteJWKSet, jwtVerify } from "jose";

import { AuthError } from "./errors.js";

export type VerifiedSession = {
  workosUserId: string;
  workosOrgId: string | null;
  sessionId: string | null;
  expiresAt: number;
  /** Signed time of active authentication; absent/malformed values cannot prove freshness. */
  authenticatedAt?: number;
};

/** A function that verifies a raw access token and returns the parsed session. */
export type TokenVerifier = (token: string) => Promise<VerifiedSession>;

export type WorkOSVerifierConfig = {
  /** WorkOS JWKS endpoint, e.g. https://api.workos.com/sso/jwks/<client-id> */
  jwksUrl: string;
  /** Expected `iss` claim in the JWT. */
  issuer: string;
  /** Expected WorkOS application client ID: the token's `client_id` must equal it. */
  audience: string;
};

/** Extracts the bearer token from an Authorization header, or returns null. */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader);
  return match ? (match[1] ?? null) : null;
}

/** Creates a production verifier that validates WorkOS JWTs against the JWKS endpoint. */
export function createWorkOSVerifier(config: WorkOSVerifierConfig): TokenVerifier {
  if (!config.audience) throw new Error("WorkOS verifier needs the app client ID");
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

  return async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
      });

      const claims = payload as Record<string, unknown>;

      if (!payload.sub) {
        throw new AuthError("TOKEN_INVALID", "JWT is missing required sub claim");
      }
      if (payload.exp === undefined) {
        throw new AuthError("TOKEN_INVALID", "JWT is missing required exp claim");
      }
      // Only tokens WorkOS minted for our own app reach /api. Tokens for MCP or other
      // AI apps (WorkOS Connect) and WorkOS agent tokens can share our issuer and keys,
      // so each check below refuses one of them (VAY-2501).
      if (claims["client_id"] !== config.audience) {
        throw new AuthError(
          "TOKEN_INVALID",
          "JWT client_id claim does not match expected client ID",
        );
      }
      if (claims["sub_profile"] !== undefined) {
        throw new AuthError("TOKEN_INVALID", "JWT is a WorkOS agent token");
      }
      if (!isAppAudience(claims["aud"], config.audience)) {
        throw new AuthError("TOKEN_INVALID", "JWT audience is not the app client ID");
      }

      return {
        workosUserId: payload.sub,
        workosOrgId: typeof claims["org_id"] === "string" ? claims["org_id"] : null,
        sessionId: typeof claims["sid"] === "string" ? claims["sid"] : null,
        expiresAt: payload.exp,
        ...(typeof claims["auth_time"] === "number" &&
        Number.isSafeInteger(claims["auth_time"]) &&
        claims["auth_time"] > 0
          ? { authenticatedAt: claims["auth_time"] }
          : {}),
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("expired") || message.includes("JWTExpired")) {
        throw new AuthError("TOKEN_EXPIRED", "Access token has expired");
      }
      throw new AuthError("TOKEN_INVALID", `Token verification failed: ${message}`);
    }
  };
}

/** App tokens carry no `aud`; if one is present it may name only our own client. */
function isAppAudience(audience: unknown, clientId: string): boolean {
  if (audience === undefined) return true;
  const audiences = Array.isArray(audience) ? audience : [audience];
  return audiences.length > 0 && audiences.every((value) => value === clientId);
}

/**
 * Creates a test verifier backed by a static token→session map.
 * Tokens not in the map throw TOKEN_INVALID; tokens whose expiresAt is in the
 * past throw TOKEN_EXPIRED.
 */
export function createFakeVerifier(tokens: Map<string, VerifiedSession>): TokenVerifier {
  return async (token: string) => {
    const session = tokens.get(token);
    if (!session) {
      throw new AuthError("TOKEN_INVALID", "Unknown token in fake verifier");
    }
    if (session.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new AuthError("TOKEN_EXPIRED", "Token has expired");
    }
    return session;
  };
}
