import { NextResponse, type NextRequest } from "next/server";

import { siteSlugForHost } from "./sites/hosts";

// The host picks the hotel: `/` on animals-ahangama.site.vayada.com serves /animals-ahangama. The
// Host header is what the load balancer routed on; X-Forwarded-Host is client-controlled.
export function middleware(request: NextRequest) {
  const slug = siteSlugForHost(request.headers.get("host") ?? "");
  if (!slug) return new NextResponse("Not found", { status: 404 });
  const url = request.nextUrl.clone();
  url.pathname = `/${slug}${url.pathname === "/" ? "" : url.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // The health check and Next's own files answer on any host.
  matcher: ["/((?!api/health|_next/).*)"],
};
