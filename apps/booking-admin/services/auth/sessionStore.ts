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
  resources?: Record<string, string[]>;
  user: AuthUser;
};

const LEGACY_TOKEN_KEY = "access_token";
const LEGACY_EXPIRES_AT_KEY = "token_expires_at";

let authKitSession: AuthKitSessionResponse | null = null;
let legacyCompatibilityToken: { token: string; expiresAt: number } | null = null;

export function isAuthKitLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED !== "false";
}

export function isLegacyPasswordFallbackEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LEGACY_FALLBACK_ENABLED === "true";
}

export function isCompatibilityTokenEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED === "true";
}

export function setAuthKitSession(session: AuthKitSessionResponse): void {
  authKitSession = session;
  if (typeof window === "undefined") return;
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", session.user.id);
  localStorage.setItem("userEmail", session.user.email);
  localStorage.setItem("userType", "hotel");
  localStorage.setItem("userStatus", session.user.status);
  localStorage.setItem("isSuperAdmin", "false");
  localStorage.setItem(
    "user",
    JSON.stringify({
      id: session.user.id,
      email: session.user.email,
      type: "hotel",
      status: session.user.status,
      is_superadmin: false,
      workos_user_id: session.user.workosUserId,
    }),
  );
}

export function setLegacyCompatibilityToken(token: string, expiresIn: number): void {
  legacyCompatibilityToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function setLegacyPasswordSession(input: {
  token: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string;
    type: string;
    status: string;
    is_superadmin?: boolean;
  };
}): void {
  if (typeof window === "undefined") return;

  localStorage.setItem(LEGACY_TOKEN_KEY, input.token);
  localStorage.setItem(LEGACY_EXPIRES_AT_KEY, String(Date.now() + input.expiresIn * 1000));
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", input.user.id);
  localStorage.setItem("userEmail", input.user.email);
  localStorage.setItem("userName", input.user.name);
  localStorage.setItem("userType", input.user.type);
  localStorage.setItem("userStatus", input.user.status);
  localStorage.setItem("isSuperAdmin", input.user.is_superadmin ? "true" : "false");
  localStorage.setItem("user", JSON.stringify(input.user));
}

export function clearAuthData(): void {
  authKitSession = null;
  legacyCompatibilityToken = null;
  if (typeof window === "undefined") return;

  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.removeItem("userId");
  localStorage.removeItem("userEmail");
  localStorage.removeItem("userName");
  localStorage.removeItem("userType");
  localStorage.removeItem("userStatus");
  localStorage.removeItem("user");
  localStorage.removeItem("selectedHotelId");
  localStorage.removeItem("isSuperAdmin");
  localStorage.setItem("isLoggedIn", "false");
}

export function getAuthCsrfToken(): string | null {
  return authKitSession?.csrfToken ?? null;
}

export function getAuthKitAccessToken(): string | null {
  return authKitSession?.accessToken ?? null;
}

export function getAuthBearerToken(): string | null {
  if (authKitSession?.accessToken) return authKitSession.accessToken;
  return getLegacyPasswordToken();
}

export function getLegacyAdminBearerToken(): string | null {
  const compatibilityToken = currentCompatibilityToken();
  if (isCompatibilityTokenEnabled() && compatibilityToken) return compatibilityToken;
  if (isCompatibilityTokenEnabled()) return null;
  return getAuthBearerToken();
}

export function getLegacyCompatibilityToken(): string | null {
  return currentCompatibilityToken();
}

export function getScopedBookingHotelIds(): string[] {
  const sessionScope = authKitSession?.resources?.["booking:booking_hotel"];
  const bookingHotelIds = new Set(
    Array.isArray(sessionScope)
      ? sessionScope.filter((resourceId): resourceId is string => typeof resourceId === "string")
      : [],
  );
  const tokens = [getAuthBearerToken(), getAuthKitAccessToken()].filter((token): token is string =>
    Boolean(token),
  );

  for (const token of tokens) {
    const payload = decodeJwtPayload(token);
    const resources = isRecord(payload?.resources) ? payload.resources : null;
    const scopedIds = resources?.["booking:booking_hotel"];
    if (!Array.isArray(scopedIds)) continue;
    for (const resourceId of scopedIds) {
      if (typeof resourceId === "string") bookingHotelIds.add(resourceId);
    }
  }

  return Array.from(bookingHotelIds);
}

export function getSelectedOrganizationId(): string | null {
  if (authKitSession?.organizationId) return authKitSession.organizationId;
  if (!isCompatibilityTokenEnabled()) return null;

  const token = currentCompatibilityToken() ?? getLegacyPasswordToken();
  if (!token) return null;

  const payload = decodeJwtPayload(token);
  return typeof payload?.org === "string" ? payload.org : null;
}

export function getLegacyPasswordToken(): string | null {
  if (typeof window === "undefined") return null;

  const token = localStorage.getItem(LEGACY_TOKEN_KEY);
  const expiresAt = localStorage.getItem(LEGACY_EXPIRES_AT_KEY);

  if (!token || !expiresAt) return null;

  if (Date.now() >= Number(expiresAt)) {
    clearAuthData();
    return null;
  }

  return token;
}

export function hasAuthenticatedSession(): boolean {
  if (authKitSession?.accessToken) {
    return Boolean(getAuthBearerToken());
  }
  return Boolean(getLegacyPasswordToken());
}

export function hasHotelAccessMarker(): boolean {
  if (authKitSession) return true;
  if (typeof window === "undefined") return false;
  return (
    localStorage.getItem("userType") === "hotel" || localStorage.getItem("isSuperAdmin") === "true"
  );
}

function currentCompatibilityToken(): string | null {
  if (!legacyCompatibilityToken) return null;
  return Date.now() < legacyCompatibilityToken.expiresAt - 30_000
    ? legacyCompatibilityToken.token
    : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload || typeof globalThis.atob !== "function") return null;

  try {
    const normalized = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
