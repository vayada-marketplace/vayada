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

export async function resolveSlugFromHost(hostname: string): Promise<string | null | undefined> {
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

  // Custom domain — resolve via the booking-engine API.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "https://api.booking.localhost";
  try {
    const res = await fetch(`${apiUrl}/api/resolve-domain?domain=${encodeURIComponent(host)}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.slug) return data.slug as string;
    }
  } catch {
    // fall through
  }
  return process.env.NEXT_PUBLIC_HOTEL_SLUG || null;
}
