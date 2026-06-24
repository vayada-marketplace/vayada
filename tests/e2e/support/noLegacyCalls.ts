import type { Page, Request, TestInfo } from "@playwright/test";

type LegacyCallRule = {
  name: string;
  matches: (request: Request, url: URL) => boolean;
};

const legacyProductionHosts = new Set([
  "api.vayada.com",
  "booking-api.vayada.com",
  "pms-api.vayada.com",
]);

const surfaceRules = {
  "booking-admin-benefits-settings": [
    legacyProductionHostRule(),
    pathRule("/admin/benefits", "legacy Booking Admin benefits route"),
    headerRule(
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
      /^\/api\/booking\/hotels\/[^/]+\/settings\/benefits$/,
    ),
  ],
  "booking-admin-booking-flow": [
    legacyProductionHostRule(),
    pathPrefixRule("/admin/addons", "legacy Booking Admin add-on item route"),
    pathPrefixRule("/admin/promo-codes", "legacy Booking Admin promo-code route"),
    pathRule("/admin/hotel", "legacy Booking Admin hotel settings route"),
    pathRule("/admin/settings/addons", "legacy Booking Admin add-on settings route"),
    pathRule("/admin/settings/design", "legacy Booking Admin design settings route"),
    pathPrefixRule("/api/hotels/", "legacy public hotel helper route"),
    headerOnPathPrefixRule(
      "/api/booking/hotels/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
    headerOnPathPrefixRule(
      "/api/pms/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
  ],
  "booking-admin-settings": [
    legacyProductionHostRule(),
    pathPrefixRule("/admin/settings/custom-domain", "legacy Booking Admin custom-domain route"),
    pathRule("/admin/payment-settings", "legacy Booking Admin payment settings route"),
    pathRule("/admin/room-types", "legacy Booking Admin room-types route"),
    headerOnPathPrefixRule(
      "/api/pms/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
    headerOnPathPrefixRule(
      "/api/finance/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
  ],
  "booking-admin-setup": [
    legacyProductionHostRule(),
    pathPrefixRule("/admin/addons", "legacy Booking Admin add-on item route"),
    pathPrefixRule("/admin/promo-codes", "legacy Booking Admin promo-code route"),
    pathRule("/admin/hotel", "legacy Booking Admin hotel settings route"),
    pathRule("/admin/payment-settings", "legacy Booking Admin payment settings route"),
    headerOnPathPrefixRule(
      "/api/finance/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
  ],
} satisfies Record<string, LegacyCallRule[]>;

export type NoLegacyCallSurface = keyof typeof surfaceRules;

export function watchNoLegacyCalls(page: Page, testInfo: TestInfo, surface: NoLegacyCallSurface) {
  const failures: string[] = [];
  const rules = surfaceRules[surface];

  page.on("request", (request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }

    for (const rule of rules) {
      if (!rule.matches(request, url)) continue;
      failures.push(`${rule.name}: ${request.method()} ${request.url()}`);
    }
  });

  return async () => {
    if (failures.length === 0) return;
    const body = failures.join("\n");
    await testInfo.attach(`${surface}-legacy-calls`, {
      body,
      contentType: "text/plain",
    });
    throw new Error(`No legacy calls guard failed for ${surface}:\n${body}`);
  };
}

function legacyProductionHostRule(): LegacyCallRule {
  return {
    name: "legacy production API host",
    matches: (_request, url) => legacyProductionHosts.has(url.hostname),
  };
}

function pathRule(pathname: string, name: string): LegacyCallRule {
  return {
    name,
    matches: (_request, url) => url.pathname === pathname,
  };
}

function pathPrefixRule(pathnamePrefix: string, name: string): LegacyCallRule {
  return {
    name,
    matches: (_request, url) => url.pathname.startsWith(pathnamePrefix),
  };
}

function headerRule(headerName: string, name: string, pathPattern?: RegExp): LegacyCallRule {
  const normalizedHeaderName = headerName.toLowerCase();
  return {
    name,
    matches: (request) =>
      (!pathPattern || pathPattern.test(new URL(request.url()).pathname)) &&
      Object.entries(request.headers()).some(
        ([candidate, value]) =>
          candidate.toLowerCase() === normalizedHeaderName && value.trim().length > 0,
      ),
  };
}

function headerOnPathPrefixRule(
  pathnamePrefix: string,
  headerName: string,
  name: string,
): LegacyCallRule {
  const header = headerRule(headerName, name);
  return {
    name,
    matches: (request, url) =>
      url.pathname.startsWith(pathnamePrefix) && header.matches(request, url),
  };
}
