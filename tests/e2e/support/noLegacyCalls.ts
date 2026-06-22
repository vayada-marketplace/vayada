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

function headerRule(headerName: string, name: string, pathPattern?: RegExp): LegacyCallRule {
  return {
    name,
    matches: (request) =>
      (!pathPattern || pathPattern.test(new URL(request.url()).pathname)) &&
      Object.entries(request.headers()).some(
        ([candidate, value]) => candidate.toLowerCase() === headerName && value.trim().length > 0,
      ),
  };
}
