import type { Page, TestInfo } from "@playwright/test";

const ignoredConsoleErrorPatterns = [
  /favicon\.ico/i,
  /favicon.*failed to load resource/i,
  /favicon.*net::ERR_ABORTED/i,
  /webpack-hmr/i,
  /WebSocket connection .* failed/i,
];

/** The PMS mocks answer their test property's (PMS_WEB_PROPERTY_ID in pmsWebMocks.ts) pricing-v2 read with 404
 * ("no prices yet", before a first publication); the Booking Admin mocks answer its setup checklist with 404 (not
 * mounted while the server's first run is off, VAY-2247). A 404 for any other property or path still fails. */
const expectedMissingByDefault = [
  /\/api\/pms\/properties\/f6853000-0000-4000-8000-000000000001\/pricing-v2$/,
  /\/api\/hotel-setup\/properties\/f6853000-0000-4000-8000-000000000001\/checklist$/,
];

/** `expectedMissingUrls`: resources whose 404 is a documented "not configured yet" answer. */
export function watchPageHealth(
  page: Page,
  testInfo: TestInfo,
  { expectedMissingUrls = [] }: { expectedMissingUrls?: RegExp[] } = {},
) {
  const failures: string[] = [];
  // A full navigation (page.goto, a reload) aborts the old page's fetches still in flight, and the
  // API clients log each one as "TypeError: Failed to fetch": the page being left, not a page
  // error (filters.spec.ts's second goto raced the header's stats read, VAY-2316). From the
  // navigation request until the new page's DOMContentLoaded, each such error is set aside and
  // excused by one fetch the navigation aborted; the ones left over still fail.
  let leaving = false;
  let aborted = 0;
  let setAside: string[] = [];
  const settle = () => {
    failures.push(...setAside.slice(aborted));
    leaving = false;
    aborted = 0;
    setAside = [];
  };
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) leaving = true;
  });
  page.on("requestfailed", (request) => {
    const fetched = ["fetch", "xhr"].includes(request.resourceType());
    if (leaving && fetched && request.failure()?.errorText === "net::ERR_ABORTED") aborted += 1;
  });
  page.on("domcontentloaded", () => {
    if (leaving) settle();
  });

  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ignoredConsoleErrorPatterns.some((pattern) => pattern.test(text))) return;
    if (leaving && /TypeError: Failed to fetch/.test(text)) {
      setAside.push(`console.error: ${text}`);
      return;
    }
    if (
      /status of 404/.test(text) &&
      [...expectedMissingByDefault, ...expectedMissingUrls].some((pattern) =>
        pattern.test(message.location().url),
      )
    )
      return;
    failures.push(`console.error: ${text}`);
  });

  return async () => {
    if (leaving) settle();
    if (failures.length === 0) return;
    await testInfo.attach("page-health-errors", {
      body: failures.join("\n\n"),
      contentType: "text/plain",
    });
    throw new Error(`Page health check failed:\n${failures.join("\n")}`);
  };
}
