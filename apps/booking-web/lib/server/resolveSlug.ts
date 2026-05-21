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
 *   - `undefined` for localhost, where the HotelContext does
 *     client-side resolution from `?slug=` / localStorage so a single
 *     dev container can serve any hotel
 */
export async function resolveSlugFromHost(hostname: string): Promise<string | null | undefined> {
  const host = hostname.toLowerCase()
  const isLocalhost = host.includes('localhost') || host.startsWith('127.0.0.1')
  if (isLocalhost) return undefined

  const isSubdomain = host.endsWith('.booking.vayada.com')
  if (isSubdomain) {
    const parts = host.split('.')
    const sub = parts.length >= 3 && parts[0] !== 'www' ? parts[0] : null
    return sub || process.env.NEXT_PUBLIC_HOTEL_SLUG || null
  }

  // Custom domain — resolve via the booking-engine API.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001'
  try {
    const res = await fetch(
      `${apiUrl}/api/resolve-domain?domain=${encodeURIComponent(host.split(':')[0])}`,
      { cache: 'no-store' },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.slug) return data.slug as string
    }
  } catch {
    // fall through
  }
  return process.env.NEXT_PUBLIC_HOTEL_SLUG || null
}
