/**
 * Local user-display data for the affiliate dashboard.
 *
 * AuthKit access tokens and PMS compatibility tokens are kept in memory only.
 * localStorage is limited to non-sensitive display hints for the navbar and
 * loading states.
 */

const USER_KEYS = ["userId", "userEmail", "userName", "userType", "userStatus", "user"] as const;

export interface StoredUser {
  id: string;
  email: string;
  name?: string;
  type: string;
  status: string;
  workosUserId?: string;
}

export type AuthKitSessionResponse = {
  accessToken: string;
  csrfToken?: string;
  organizationId?: string;
  user: {
    id: string;
    email: string;
    status: string;
    workosUserId?: string;
  };
};

let authKitSession: AuthKitSessionResponse | null = null;
let legacyCompatibilityToken: { token: string; expiresAt: number } | null = null;

export function isCompatibilityTokenEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED === "true";
}

export function storeUser(data: StoredUser): void {
  if (typeof window === "undefined") return;
  const displayName = data.name || displayNameFromEmail(data.email);
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", data.id);
  localStorage.setItem("userEmail", data.email);
  localStorage.setItem("userName", displayName);
  localStorage.setItem("userType", data.type);
  localStorage.setItem("userStatus", data.status);
  localStorage.setItem("user", JSON.stringify({ ...data, name: displayName }));
}

export function setAuthKitSession(session: AuthKitSessionResponse): void {
  authKitSession = session;
  storeUser({
    id: session.user.id,
    email: session.user.email,
    name: displayNameFromEmail(session.user.email),
    type: "affiliate",
    status: session.user.status,
    workosUserId: session.user.workosUserId,
  });
}

export function setLegacyCompatibilityToken(token: string, expiresIn: number): void {
  legacyCompatibilityToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function clearAuthData(): void {
  authKitSession = null;
  legacyCompatibilityToken = null;
  if (typeof window === "undefined") return;
  for (const key of USER_KEYS) localStorage.removeItem(key);
  localStorage.setItem("isLoggedIn", "false");
}

export function getUserType(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("userType");
}

export function getUserName(): string {
  if (typeof window === "undefined") return "";
  return (
    localStorage.getItem("userName") || displayNameFromEmail(localStorage.getItem("userEmail"))
  );
}

export function getAuthCsrfToken(): string | null {
  return authKitSession?.csrfToken ?? null;
}

export function getAuthBearerToken(): string | null {
  const compatibilityToken = getLegacyCompatibilityToken();
  if (isCompatibilityTokenEnabled() && compatibilityToken) return compatibilityToken;
  if (authKitSession?.accessToken) return authKitSession.accessToken;
  return null;
}

function getLegacyCompatibilityToken(): string | null {
  if (legacyCompatibilityToken && Date.now() < legacyCompatibilityToken.expiresAt - 30_000) {
    return legacyCompatibilityToken.token;
  }
  return null;
}

export function hasAuthenticatedSession(): boolean {
  return Boolean(authKitSession?.accessToken);
}

export function hasCompatibilityToken(): boolean {
  return Boolean(getLegacyCompatibilityToken());
}

/** Client-side hint based on the last successful login. The cookie is
 * httpOnly so we cannot inspect it directly; if the cookie has expired
 * server-side, the next API call will 401 and the API client redirects
 * to /login. The Next middleware does the authoritative gate at
 * navigation time. */
export function isLoggedInHint(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("isLoggedIn") === "true";
}

function displayNameFromEmail(email: string | null): string {
  if (!email) return "Affiliate partner";
  const [localPart] = email.split("@");
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
