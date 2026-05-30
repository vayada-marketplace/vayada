import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { routing } from "./i18n/routing";

const intlMiddleware = createMiddleware(routing);

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.booking.localhost";

function getKnownSubdomainSlug(hostname: string): string | null {
  const host = hostname.toLowerCase().split(":")[0];
  const parts = host.split(".");

  if (host.endsWith(".booking.vayada.com") || host.endsWith(".booking.localhost")) {
    return parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
  }

  if (host.endsWith(".localhost")) {
    return parts.length === 2 && parts[0] !== "www" ? parts[0] : null;
  }

  return null;
}

export default async function middleware(request: NextRequest) {
  const response = intlMiddleware(request);

  // Hostnames are case-insensitive per RFC 1035 §2.3.3 but the backend
  // lookup keys are stored lowercased — normalize here so a stray
  // uppercase Host header still resolves.
  const hostname = (request.headers.get("host") || "").toLowerCase();

  let slug = getKnownSubdomainSlug(hostname);

  if (!slug && !hostname.includes("localhost") && !hostname.endsWith(".booking.vayada.com")) {
    // Custom domain: resolve slug via API
    try {
      const res = await fetch(
        `${API_URL}/api/resolve-domain?domain=${encodeURIComponent(hostname.split(":")[0])}`,
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

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
