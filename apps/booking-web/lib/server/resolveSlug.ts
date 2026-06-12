import { cache } from "react";

import { bookingWebPublicApi } from "@/services/api/bookingWebPublic";
import { PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS } from "@/services/api/bookingWebPublic";

/**
 * Server-side hostname → hotel-slug resolver. Mirrors the client-edge
 * middleware so the locale layout and generateMetadata can share one
 * implementation.
 *
 * Returns:
 *   - the slug when one can be derived from the host
 *   - `null` when the host has no mapping (caller should render
 *     "Domain not configured" rather than fall back to a placeholder
 *     slug — the storefront previously fell through to `hotel-alpenrose`,
 *     which is the dev seed and 404s in prod, surfacing as a confusing
 *     "Hotel 'hotel-alpenrose' not found" error)
 *   - `undefined` for bare localhost, where the HotelContext does
 *     client-side resolution from `?slug=` / localStorage so a single
 *     dev container can serve any hotel
 */
function normalizeHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    return normalized.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
  }
  return normalized.replace(/:\d+$/, "");
}

export const resolveSlugFromHost = cache(
  async (hostname: string): Promise<string | null | undefined> =>
    resolveSlugFromHostUncached(hostname),
);

async function resolveSlugFromHostUncached(hostname: string): Promise<string | null | undefined> {
  const host = normalizeHost(hostname);

  if (host.endsWith(".booking.localhost")) {
    const parts = host.split(".");
    const sub = parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
    return sub || undefined;
  }

  if (host.endsWith(".localhost")) {
    const parts = host.split(".");
    const sub =
      parts.length === 2 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
    return sub || undefined;
  }

  const isLocalhost = host === "localhost" || host.startsWith("127.0.0.1") || host === "::1";
  if (isLocalhost) return undefined;

  const isSubdomain = host.endsWith(".booking.vayada.com");
  if (isSubdomain) {
    const parts = host.split(".");
    const sub = parts.length >= 3 && parts[0] !== "www" ? parts[0] : null;
    return sub || process.env.NEXT_PUBLIC_HOTEL_SLUG || null;
  }

  try {
    const data = await bookingWebPublicApi.resolveHost(host, {
      next: { revalidate: PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS },
    });
    if (data?.slug) return data.slug;
  } catch {
    // fall through
  }
  return process.env.NEXT_PUBLIC_HOTEL_SLUG || null;
}
