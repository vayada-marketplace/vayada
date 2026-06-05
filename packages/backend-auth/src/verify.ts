import { createRemoteJWKSet, jwtVerify } from "jose";

import { AuthError } from "./errors.js";

export type VerifiedSession = {
  workosUserId: string;
  workosOrgId: string | null;
  sessionId: string | null;
  expiresAt: number;
};

/** A function that verifies a raw access token and returns the parsed session. */
export type TokenVerifier = (token: string) => Promise<VerifiedSession>;

export type WorkOSVerifierConfig = {
  /** WorkOS JWKS endpoint, e.g. https://api.workos.com/sso/jwks/<client-id> */
  jwksUrl: string;
  /** Expected `iss` claim in the JWT. */
  issuer: string;
  /** Expected WorkOS application client ID. */
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
      if (!hasExpectedClientId(claims, config.audience)) {
        throw new AuthError(
          "TOKEN_INVALID",
          "JWT client_id claim does not match expected client ID",
        );
      }

      return {
        workosUserId: payload.sub,
        workosOrgId: typeof claims["org_id"] === "string" ? claims["org_id"] : null,
        sessionId: typeof claims["sid"] === "string" ? claims["sid"] : null,
        expiresAt: payload.exp,
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

function hasExpectedClientId(claims: Record<string, unknown>, expectedClientId: string): boolean {
  if (typeof claims["client_id"] === "string") {
    return claims["client_id"] === expectedClientId;
  }

  const audience = claims["aud"];
  if (typeof audience === "string") {
    return audience === expectedClientId;
  }
  if (Array.isArray(audience)) {
    return audience.includes(expectedClientId);
  }

  return false;
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
