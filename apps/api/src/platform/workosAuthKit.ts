import { WorkOS } from "@workos-inc/node";

import type { AuthKitClient, AuthKitSession } from "../routes/authSession.js";

type WorkOSAuthKitClientConfig = {
  apiKey: string;
  clientId: string;
  cookiePassword: string;
};

export function createWorkOSAuthKitClient(config: WorkOSAuthKitClientConfig): AuthKitClient {
  const workos = new WorkOS(config.apiKey, {
    clientId: config.clientId,
  });

  return {
    getAuthorizationUrl(input) {
      return workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: config.clientId,
        redirectUri: input.redirectUri,
        state: input.state,
        organizationId: input.organizationId,
        loginHint: input.loginHint,
      });
    },

    async authenticateWithCode(input) {
      const response = await workos.userManagement.authenticateWithCode({
        code: input.code,
        clientId: config.clientId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        session: {
          sealSession: true,
          cookiePassword: config.cookiePassword,
        },
      });
      return toAuthKitSession(response);
    },

    async authenticateSession(input) {
      const response = await workos.userManagement
        .loadSealedSession({
          sessionData: input.sealedSession,
          cookiePassword: config.cookiePassword,
        })
        .authenticate();
      if (!response.authenticated) return null;
      return toAuthKitSession({
        ...response,
        sealedSession: input.sealedSession,
      });
    },

    async refreshSession(input) {
      const loaded = workos.userManagement.loadSealedSession({
        sessionData: input.sealedSession,
        cookiePassword: config.cookiePassword,
      });
      const refreshed = await loaded.refresh({
        cookiePassword: config.cookiePassword,
        organizationId: input.organizationId,
      });
      if (!refreshed.authenticated || !refreshed.sealedSession) return null;

      const authenticated = await workos.userManagement
        .loadSealedSession({
          sessionData: refreshed.sealedSession,
          cookiePassword: config.cookiePassword,
        })
        .authenticate();
      if (!authenticated.authenticated) return null;
      return toAuthKitSession({
        ...authenticated,
        sealedSession: refreshed.sealedSession,
      });
    },

    async getLogoutUrl(input) {
      return workos.userManagement
        .loadSealedSession({
          sessionData: input.sealedSession,
          cookiePassword: config.cookiePassword,
        })
        .getLogoutUrl({
          returnTo: input.returnTo,
        });
    },

    async updateUserExternalId(input) {
      await workos.userManagement.updateUser({
        userId: input.workosUserId,
        externalId: input.externalId,
      });
    },
  };
}

function toAuthKitSession(response: {
  accessToken: string;
  sealedSession?: string;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    name?: string | null;
  };
  organizationId?: string;
  sessionId?: string;
}): AuthKitSession {
  if (!response.sealedSession) {
    throw new Error("WorkOS response did not include a sealed session");
  }
  return {
    accessToken: response.accessToken,
    sealedSession: response.sealedSession,
    user: {
      id: response.user.id,
      email: response.user.email,
      emailVerified: response.user.emailVerified,
      name: response.user.name,
    },
    organizationId: response.organizationId,
    sessionId: response.sessionId,
  };
}
