import { setApiBearerTokenProvider } from "@vayada/marketplace-shared/api/client";
import { STORAGE_KEYS } from "@/lib/constants";
import type { UserType } from "@/lib/types";

export type AuthUser = {
  id: string;
  email: string;
  status: string;
  workosUserId?: string;
};

export type AuthKitSessionResponse = {
  accessToken: string;
  csrfToken?: string;
  organizationId?: string;
  organizationKind?: "creator_workspace" | "hotel_group" | "platform" | "affiliate_partner";
  user: AuthUser;
};

const LEGACY_TOKEN_KEY = "access_token";
const LEGACY_EXPIRES_AT_KEY = "token_expires_at";

let authKitSession: AuthKitSessionResponse | null = null;

// Marketplace shared API calls need the in-memory AuthKit bearer token before
// any page-level bootstrap code runs, so the provider is intentionally wired on import.
setApiBearerTokenProvider(() => getAuthBearerToken());

export function isAuthKitLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED !== "false";
}

export function setAuthKitSession(session: AuthKitSessionResponse): void {
  authKitSession = session;
  if (typeof window === "undefined") return;

  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);

  const userType = userTypeForOrganizationKind(session.organizationKind);
  const userName = session.user.email;
  localStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");
  localStorage.setItem(STORAGE_KEYS.USER_ID, session.user.id);
  localStorage.setItem(STORAGE_KEYS.USER_EMAIL, session.user.email);
  localStorage.setItem(STORAGE_KEYS.USER_NAME, userName);
  localStorage.setItem(STORAGE_KEYS.USER_STATUS, session.user.status);
  localStorage.setItem(STORAGE_KEYS.IS_SUPERADMIN, "false");
  if (userType) {
    localStorage.setItem(STORAGE_KEYS.USER_TYPE, userType);
  } else {
    localStorage.removeItem(STORAGE_KEYS.USER_TYPE);
  }
  localStorage.setItem(
    STORAGE_KEYS.USER,
    JSON.stringify({
      id: session.user.id,
      email: session.user.email,
      name: userName,
      type: userType,
      status: session.user.status,
      is_superadmin: false,
      workos_user_id: session.user.workosUserId,
      organization_kind: session.organizationKind,
    }),
  );
}

export function clearAuthData(): void {
  authKitSession = null;
  if (typeof window === "undefined") return;

  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.removeItem(STORAGE_KEYS.USER_ID);
  localStorage.removeItem(STORAGE_KEYS.USER_EMAIL);
  localStorage.removeItem(STORAGE_KEYS.USER_NAME);
  localStorage.removeItem(STORAGE_KEYS.USER_TYPE);
  localStorage.removeItem(STORAGE_KEYS.USER_STATUS);
  localStorage.removeItem(STORAGE_KEYS.IS_SUPERADMIN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "false");
  localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
  localStorage.setItem(STORAGE_KEYS.HAS_PROFILE, "false");
}

export function getAuthCsrfToken(): string | null {
  return authKitSession?.csrfToken ?? null;
}

export function getAuthBearerToken(): string | null {
  return authKitSession?.accessToken ?? null;
}

export function hasAuthenticatedSession(): boolean {
  return Boolean(authKitSession?.accessToken);
}

export function currentUserType(): UserType | null {
  return userTypeForOrganizationKind(authKitSession?.organizationKind);
}

function userTypeForOrganizationKind(
  organizationKind: AuthKitSessionResponse["organizationKind"] | undefined,
): UserType | null {
  if (organizationKind === "creator_workspace") return "creator";
  if (organizationKind === "hotel_group") return "hotel";
  return null;
}
