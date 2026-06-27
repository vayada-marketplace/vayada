import {
  getAuthCsrfToken,
  getLegacyCompatibilityToken,
  isCompatibilityTokenEnabled,
  setLegacyCompatibilityToken,
} from "./sessionStore";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";

type CompatibilityTokenResponse = {
  accessToken: string;
  expiresIn: number;
};

export async function ensureBookingCompatibilityToken(): Promise<void> {
  if (!isCompatibilityTokenEnabled() || getLegacyCompatibilityToken()) return;

  const csrfToken = getAuthCsrfToken();
  if (!csrfToken) return;

  const response = await fetch(`${AUTH_API_BASE_URL}/auth/compat/booking-admin-token`, {
    method: "POST",
    credentials: "include",
    headers: { "x-vayada-csrf": csrfToken },
  });
  if (!response.ok) {
    throw new Error("Booking compatibility token request failed.");
  }

  const body = (await response.json()) as CompatibilityTokenResponse;
  setLegacyCompatibilityToken(body.accessToken, body.expiresIn);
}
