import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import {
  getCanonicalHostRedirectUrl,
  isFallbackBookingHost,
  resolvePublicHotelUrls,
} from "./lib/server/publicUrls";

const intlMiddleware = createMiddleware(routing);

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.booking.localhost";

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

  if (host.endsWith(".booking.vayada.com") || host.endsWith(".booking.localhost")) {
    return parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
  }

  if (host.endsWith(".localhost")) {
    return parts.length === 2 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
  }

  return null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.startsWith("127.0.0.1") || hostname === "::1";
}

export default async function middleware(request: NextRequest) {
  const response = intlMiddleware(request);

  // Hostnames are case-insensitive per RFC 1035 §2.3.3 but the backend
  // lookup keys are stored lowercased — normalize here so a stray
  // uppercase Host header still resolves.
  const hostname = normalizeHost(request.headers.get("host") || "");

  let slug = getKnownSubdomainSlug(hostname);

  if (
    !slug &&
    !hostname.includes("localhost") &&
    !isLocalHost(hostname) &&
    !hostname.endsWith(".booking.vayada.com")
  ) {
    // Custom domain: resolve slug via API
    try {
      const res = await fetch(
        `${API_URL}/api/resolve-domain?domain=${encodeURIComponent(hostname)}`,
      );
      if (res.ok) {
        const data = await res.json();
        slug = data.slug;
      }
    } catch {
      // Resolution failed — slug stays null
    }
  }

  if (slug) {
    const canonicalRedirect = await resolveCanonicalRedirect(request, hostname, slug);
    if (canonicalRedirect) return canonicalRedirect;
    response.cookies.set("hotel-slug", slug, { path: "/" });
  }

  // Capture referral code from ?ref= query param → 30-day cookie
  const refCode = request.nextUrl.searchParams.get("ref");
  if (refCode) {
    response.cookies.set("ref", refCode, {
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      sameSite: "lax",
    });
  }

  return response;
}

async function resolveCanonicalRedirect(
  request: NextRequest,
  hostname: string,
  slug: string,
): Promise<NextResponse | null> {
  if (!isFallbackBookingHost(hostname)) return null;

  try {
    const res = await fetch(`${API_URL}/api/hotels/${slug}`, { cache: "no-store" });
    if (!res.ok) return null;
    const hotel = await res.json();
    const policy = resolvePublicHotelUrls({
      requestHost: request.headers.get("host") || hostname,
      requestProtocol: request.nextUrl.protocol === "http:" ? "http" : "https",
      slug: hotel?.slug || slug,
      locale: firstLocaleSegment(request.nextUrl.pathname) || "en",
      supportedLocales: hotel?.supportedLanguages,
      customDomainUrl: hotel?.customDomainUrl,
    });
    const redirectUrl = getCanonicalHostRedirectUrl(policy, request.nextUrl);
    return redirectUrl ? NextResponse.redirect(redirectUrl, 308) : null;
  } catch {
    return null;
  }
}

function firstLocaleSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return routing.locales.includes(segment as (typeof routing.locales)[number]) ? segment : null;
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
