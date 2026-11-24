import type { NextRequest } from "next/server";
import { reportOnlyCspResponse } from "@vayada/web-security/csp";

// VAY-2516: every page gets a fresh nonce and the report-only Content-Security-Policy.
export function proxy(request: NextRequest) {
  return reportOnlyCspResponse(request, {
    connectUrls: [
      process.env.NEXT_PUBLIC_AUTH_API_URL,
      process.env.NEXT_PUBLIC_PMS_API_URL,
      process.env.NEXT_PUBLIC_PMS_OPERATIONS_API_URL,
      process.env.NEXT_PUBLIC_VAYADA_API_URL,
      process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL,
    ],
    development: process.env.NODE_ENV !== "production",
  });
}

export const config = {
  matcher: [
    {
      // Pages only: not static files, the auth gateway routes or the report endpoint, and not
      // prefetches, whose payload has no scripts to mark.
      source:
        "/((?!_next/static|_next/image|auth/|csp-report|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|ico|txt|xml|json|woff2?)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
