import type { Page, TestInfo } from "@playwright/test";

const ignoredConsoleErrorPatterns = [
  /favicon\.ico/i,
  /favicon.*failed to load resource/i,
  /favicon.*net::ERR_ABORTED/i,
  /webpack-hmr/i,
  /WebSocket connection .* failed/i,
];

/** The PMS mocks answer their test property's (PMS_WEB_PROPERTY_ID in pmsWebMocks.ts) pricing-v2 read with 404
 * ("no prices yet", before a first publication); a 404 for any other property or path still fails page health. */
const expectedMissingByDefault = [
  /\/api\/pms\/properties\/f6853000-0000-4000-8000-000000000001\/pricing-v2$/,
];

/** `expectedMissingUrls`: resources whose 404 is a documented "not configured yet" answer. */
export function watchPageHealth(
  page: Page,
  testInfo: TestInfo,
  { expectedMissingUrls = [] }: { expectedMissingUrls?: RegExp[] } = {},
) {
  const failures: string[] = [];

  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ignoredConsoleErrorPatterns.some((pattern) => pattern.test(text))) return;
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
    if (failures.length === 0) return;
    await testInfo.attach("page-health-errors", {
      body: failures.join("\n\n"),
      contentType: "text/plain",
    });
    throw new Error(`Page health check failed:\n${failures.join("\n")}`);
  };
}
