import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { getRequestHost } from "./lib/requestHost";
import {
  getCanonicalHostRedirectUrl,
  isFallbackBookingHost,
  resolvePublicHotelUrls,
} from "./lib/server/publicUrls";
import {
  bookingWebPublicApi,
  PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS,
  type BookingWebPublicHostResponse,
} from "./services/api/bookingWebPublic";

const intlMiddleware = createMiddleware(routing);

function normalizeHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    return normalized.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
  }
  return normalized.replace(/:\d+$/, "");
}

function getKnownSubdomainSlug(hostname: string): string | null {
  const host = normalizeHost(hostname);
  const parts = host.split(".");

  if (
    host.endsWith(".booking.vayada.com") ||
    host.endsWith(".next-booking.vayada.com") ||
    host.endsWith(".booking.localhost")
  ) {
    return parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
  }

  if (host.endsWith(".localhost")) {
    return parts.length === 2 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
  }

  return null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// The room list, add-on and payment pages of the retired booking flow (VAY-1543 C.2)
// answer a real permanent redirect to the room-and-price page, so crawlers and other
// clients without JavaScript see it too. Only what /book reads carries over.
const retiredBookingPagePath = /^(?:\/([^/]+))?\/(?:rooms|addons|payment)\/?$/;
const bookPageParams = ["checkIn", "checkOut", "adults", "children", "promoCode"];

async function retiredBookingPageRedirect(request: NextRequest): Promise<NextResponse | null> {
  const match = retiredBookingPagePath.exec(request.nextUrl.pathname);
  if (!match) return null;
  const locale = match[1];
  if (locale !== undefined && !routing.locales.includes(locale as (typeof routing.locales)[number]))
    return null;
  // Never build a redirect on a host Booking does not serve (spoofed forwarded host).
  const origin = await admittedPublicOrigin(request);
  if (!origin) return null;
  let target: URL;
  try {
    target = new URL(
      locale && locale !== routing.defaultLocale ? `/${locale}/book` : "/book",
      `${origin.protocol}//${origin.host}`,
    );
  } catch {
    return null; // A malformed host header: no redirect, the page simply does not exist.
  }
  for (const key of bookPageParams) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  const redirect = NextResponse.redirect(target, 308);
  // The target follows the request's own host; never let a shared cache keep it.
  redirect.headers.set("Cache-Control", "no-store");
  return redirect;
}

type PublicOrigin = { host: string; hostname: string; protocol: string };

/**
 * The browser-facing host and protocol for redirects built in middleware, or null when the
 * host is not one Booking serves: an unrecognized custom domain, or a loopback name claimed
 * by a non-local request. Next requires an absolute Location in middleware; use the host
 * Booking already uses for canonical-host redirects, not an internal proxy host in
 * request.nextUrl, and never downgrade a public host to HTTP.
 */
async function admittedPublicOrigin(request: NextRequest): Promise<PublicOrigin | null> {
  const host = getRequestHost(request.headers) || request.nextUrl.host;
  const hostname = normalizeHost(host);
  const localHost = isLocalHost(hostname) || hostname.endsWith(".localhost");
  const requestHostname = normalizeHost(request.nextUrl.host);
  const localRequest = isLocalHost(requestHostname) || requestHostname.endsWith(".localhost");
  if (
    (localHost && !localRequest) ||
    (!localHost && !getKnownSubdomainSlug(hostname) && !(await fetchHostResolution(hostname))?.slug)
  ) {
    return null;
  }
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = localHost
    ? forwardedProto === "https" || forwardedProto === "http"
      ? `${forwardedProto}:`
      : request.nextUrl.protocol
    : "https:";
  return { host, hostname, protocol };
}

export default async function middleware(request: NextRequest) {
  const retiredPageRedirect = await retiredBookingPageRedirect(request);
  if (retiredPageRedirect) return retiredPageRedirect;

  const response = intlMiddleware(request);

  // Hostnames are case-insensitive per RFC 1035 §2.3.3 but the backend
  // lookup keys are stored lowercased — normalize here so a stray
  // uppercase Host header still resolves.
  const requestHost = getRequestHost(request.headers);
  const hostname = normalizeHost(requestHost);

  const knownSlug = getKnownSubdomainSlug(hostname);
  let hostResolution: BookingWebPublicHostResponse | null = null;
  let slug = knownSlug;

  if (
    !isLocalHost(hostname) &&
    (knownSlug ||
      (!hostname.includes("localhost") &&
        !hostname.endsWith(".booking.vayada.com") &&
        !hostname.endsWith(".next-booking.vayada.com")))
  ) {
    hostResolution = await fetchHostResolution(hostname);
    slug = hostResolution?.slug || knownSlug;
  }

  if (slug && hostResolution) {
    const canonicalRedirect = resolveCanonicalRedirect(request, hostname, slug, hostResolution);
    if (canonicalRedirect) return canonicalRedirect;
  }

  // No cookies before the guest's privacy choice (VAY-2223); the hotel comes from the host.
  return response;
}

async function fetchHostResolution(
  hostname: string,
  fresh = false,
): Promise<BookingWebPublicHostResponse | null> {
  try {
    return await bookingWebPublicApi.resolveHost(hostname, {
      ...(fresh
        ? { cache: "no-store" }
        : { next: { revalidate: PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS } }),
    });
  } catch {
    return null;
  }
}

function resolveCanonicalRedirect(
  request: NextRequest,
  hostname: string,
  slug: string,
  hostResolution: BookingWebPublicHostResponse,
): NextResponse | null {
  if (!isFallbackBookingHost(hostname)) return null;

  const requestHost = getRequestHost(request.headers) || hostname;
  const policy = resolvePublicHotelUrls({
    requestHost,
    requestProtocol: request.nextUrl.protocol === "http:" ? "http" : "https",
    slug: hostResolution.hotel?.slug || slug,
    locale: firstLocaleSegment(request.nextUrl.pathname) || "en",
    supportedLocales: hostResolution.hotel?.supportedLocales,
    customDomainUrl: hostResolution.customDomainUrl,
  });
  const publicRequestUrl = new URL(request.nextUrl.toString());
  publicRequestUrl.host = requestHost;
  const redirectUrl = getCanonicalHostRedirectUrl(policy, publicRequestUrl);
  return redirectUrl ? NextResponse.redirect(redirectUrl, 308) : null;
}

function firstLocaleSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return routing.locales.includes(segment as (typeof routing.locales)[number]) ? segment : null;
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
