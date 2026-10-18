import { describe, expect, it } from "vitest";

import nextConfig from "./next.config.js";
import { bookingAdminUrl, marketingUrl } from "./redirectTargets";

// VAY-2270: the redirect table of the marketplace-web stub. It replaces the stub's browser spec when
// the Marketplace browser project left PR Checks (C2); the browser spec proved the real responses
// once (302 plus query strings kept), this test keeps the table itself from drifting.

type Redirect = { source: string; destination: string; permanent: boolean };

// Enough of Next's path matching for the three source forms next.config.js uses: a literal path,
// "/prefix/:name*" (the prefix itself or anything below it) and "/:name(regex)".
function compile(source: string): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const any = /^(.*)\/:(\w+)\*$/.exec(source);
  if (any) return new RegExp(`^${escape(any[1])}(?:/(.+))?/?$`, "i");
  const custom = /^(.*)\/:(\w+)\((.*)\)$/.exec(source);
  if (custom) return new RegExp(`^${escape(custom[1])}/(${custom[3]})$`, "i");
  if (source.includes(":")) throw new Error(`unsupported source pattern ${source}`);
  return new RegExp(`^${escape(source)}/?$`, "i");
}

async function forward(path: string): Promise<Redirect | undefined> {
  const redirects = (await nextConfig.redirects()) as Redirect[];
  return redirects.find(({ source }) => compile(source).test(path));
}

describe("marketplace-web redirect stub", () => {
  it.each([
    ["/setup", `${bookingAdminUrl}/setup`],
    ["/setup/airbnb-return/p1/s1", `${bookingAdminUrl}/setup/:path*`],
    ["/invite", `${bookingAdminUrl}/invite`],
    ["/login", `${bookingAdminUrl}/login`],
    ["/signup", `${bookingAdminUrl}/signup`],
    ["/forgot-password", `${bookingAdminUrl}/forgot-password`],
    ["/reset-password", `${bookingAdminUrl}/reset-password`],
    ["/verify-email", `${bookingAdminUrl}/verify-email`],
    ["/settings", `${bookingAdminUrl}/settings/privacy`],
    ["/settings/privacy", `${bookingAdminUrl}/settings/privacy`],
    ["/settings/delete-account", `${bookingAdminUrl}/settings/privacy`],
    ["/handoff", `${bookingAdminUrl}/login`],
    ["/onboarding", `${bookingAdminUrl}/signup`],
    ["/", marketingUrl],
    ["/creators", marketingUrl],
    ["/marketplace", marketingUrl],
    ["/profile/complete", marketingUrl],
    ["/hotels/some-hotel", marketingUrl],
    ["/some-forgotten-page", marketingUrl],
  ])("%s forwards to %s, temporarily", async (path, destination) => {
    const redirect = await forward(path);
    expect(redirect?.destination).toBe(destination);
    expect(redirect?.permanent).toBe(false);
  });

  it.each([
    "/api/health",
    "/auth/session",
    "/auth/oauth/google/callback",
    "/_next/static/chunks/main.js",
  ])("%s is served by the stub itself", async (path) => {
    expect(await forward(path)).toBeUndefined();
  });
});
