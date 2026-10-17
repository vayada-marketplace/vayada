import { apiClient, ApiErrorResponse } from "./client";

// Hotel account invitations (codes issued in Vayada Admin), moved from marketplace-web (VAY-2262).
// The API routes keep their /api/marketplace prefix until the Marketplace removal retires it.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.localhost";

export const HOTEL_ACCOUNT_INVITE_STORAGE_KEY = "vayada.hotel-account-invite.v1";
export type HotelAccountInviteTrack = "hotel_operations" | "creator_marketplace";

export type HotelAccountInviteLookup = {
  contractVersion: "hotel-account-invite.v1";
  identity: { emailHint: string };
  organization: { displayName: string };
  property: { displayName: string };
  selectedTracks: HotelAccountInviteTrack[];
  handoffPath: "/setup";
  expiresAt: string;
};

export type HotelAccountInviteRedemption = {
  contractVersion: "hotel-account-invite.v1";
  status: "redeemed" | "already_redeemed";
  selectedTracks: HotelAccountInviteTrack[];
  handoffPath: "/setup";
};

export const hotelAccountInvitesService = {
  /** Unauthenticated: the page shows the invitation before the owner signs in. */
  async lookup(code: string): Promise<HotelAccountInviteLookup> {
    const response = await fetch(`${API_BASE_URL}/api/marketplace/hotel-account-invites/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // A non-JSON error page (e.g. from the load balancer) keeps the status-based handling below.
      body = null;
    }
    if (!response.ok) {
      throw new ApiErrorResponse(
        response.status,
        (body ?? {}) as ConstructorParameters<typeof ApiErrorResponse>[1],
      );
    }
    return body as HotelAccountInviteLookup;
  },

  redeem(code: string): Promise<HotelAccountInviteRedemption> {
    return apiClient.post<HotelAccountInviteRedemption>(
      "/api/marketplace/hotel-account-invites/redeem",
      { code },
    );
  },
};

/** Reads the code from the URL fragment (never a query parameter), stores it and scrubs the URL. */
export function captureHotelAccountInviteCode(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const hashCode = normalizeInviteCode(hash.get("code"));
  if (hashCode) {
    window.sessionStorage.setItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY, hashCode);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return hashCode;
  }
  return pendingHotelAccountInviteCode();
}

export function storeHotelAccountInviteCode(code: string): string | null {
  if (typeof window === "undefined") return null;
  const normalized = normalizeInviteCode(code);
  if (!normalized) return null;
  window.sessionStorage.setItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY, normalized);
  return normalized;
}

export function pendingHotelAccountInviteCode(): string | null {
  if (typeof window === "undefined") return null;
  return normalizeInviteCode(window.sessionStorage.getItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY));
}

export function clearPendingHotelAccountInvite(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY);
}

/** The setup entry for a redeemed invitation: PMS-only invitations keep entering through the PMS flow. */
export function hotelAccountInviteSetupPath(tracks: readonly string[]): string {
  const entryProduct = tracks.length === 1 && tracks[0] === "hotel_operations" ? "pms" : "booking";
  return `/setup?entryProduct=${entryProduct}&returnProduct=${entryProduct}`;
}

function normalizeInviteCode(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return /^VAY-[A-Za-z0-9_-]{8,252}$/.test(normalized) ? normalized : null;
}
