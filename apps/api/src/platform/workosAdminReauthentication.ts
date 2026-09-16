import { createHash, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { WorkOS } from "@workos-inc/node";
import type { AdminTransferBinding } from "@vayada/backend-auth";

type SourceSession = Omit<AdminTransferBinding, "targetMembershipId" | "requestDigest">;
type Config = {
  apiKey: string;
  clientId: string;
  /** Fixed trusted callback URL from server configuration, never a request parameter. */
  callbackUrl: string;
  cookieSecret: string;
  /** Repository verification includes signed JWT identity/freshness and single-use state checks. */
  verifyProof(
    binding: AdminTransferBinding,
    state: string,
    accessToken: string,
  ): Promise<string | null>;
};
const purpose = "vayada-account-admin-reauthentication.v1";

/** Internal redirect/callback adapter. Callers authorize the source session and create the
 * validated database intent before start. Store flowCookie only in a Secure, HttpOnly,
 * SameSite=Lax cookie restricted to the callback path, max-age 300. Never put it in a URL.
 */
export function createWorkOSAdminReauthentication(config: Config) {
  if (config.cookieSecret.length < 32)
    throw new Error("Reauthentication cookie secret is too short");
  const key = createHash("sha256").update(purpose).update(config.cookieSecret).digest();
  const workos = new WorkOS(config.apiKey, { clientId: config.clientId });
  return {
    async start(binding: AdminTransferBinding, state: string, loginHint: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Invalid transfer state");
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const flowCookie = await new EncryptJWT({ binding, state, codeVerifier })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setIssuer(purpose)
        .setAudience(config.callbackUrl)
        .setIssuedAt()
        .setExpirationTime("5m")
        .encrypt(key);
      const authorizationUrl = workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: config.clientId,
        redirectUri: config.callbackUrl,
        organizationId: binding.workosOrgId,
        loginHint,
        state,
        maxAge: 0,
        codeChallenge,
        codeChallengeMethod: "S256",
      });
      return { authorizationUrl, flowCookie };
    },

    /** Call after resolving the still-live original browser session. Clear the flow cookie on
     * success or failure. Do not replace the original login cookie or return provider tokens.
     */
    async complete(input: {
      flowCookie: string;
      state: string;
      code: string;
      source: SourceSession;
      ipAddress?: string;
      userAgent?: string;
    }): Promise<{ proofId: string; binding: AdminTransferBinding } | null> {
      try {
        if (
          !input.code ||
          input.code.length > 4096 ||
          !input.flowCookie ||
          input.flowCookie.length > 8192
        )
          return null;
        const { payload } = await jwtDecrypt(input.flowCookie, key, {
          issuer: purpose,
          audience: config.callbackUrl,
          keyManagementAlgorithms: ["dir"],
          contentEncryptionAlgorithms: ["A256GCM"],
        });
        // This encrypted payload is authored only by start; validate its required structure too.
        const binding = payload.binding as AdminTransferBinding | undefined;
        if (
          !binding ||
          typeof binding !== "object" ||
          typeof payload.state !== "string" ||
          payload.state !== input.state ||
          typeof payload.codeVerifier !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(payload.codeVerifier)
        )
          return null;
        for (const field of [
          "organizationId",
          "actorMembershipId",
          "workosUserId",
          "workosOrgId",
          "sessionId",
        ] as const) {
          if (!input.source[field] || binding[field] !== input.source[field]) return null;
        }
        if (!binding.targetMembershipId || !/^[a-f0-9]{64}$/.test(binding.requestDigest))
          return null;
        const response = await workos.userManagement.authenticateWithCode({
          code: input.code,
          codeVerifier: payload.codeVerifier,
          clientId: config.clientId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        if (response.impersonator) return null;
        const proofId = await config.verifyProof(binding, input.state, response.accessToken);
        return proofId ? { proofId, binding } : null;
      } catch {
        // Provider errors can contain authorization codes/tokens; callers receive no raw diagnostics.
        return null;
      }
    },
  };
}
