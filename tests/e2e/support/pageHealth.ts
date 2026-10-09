import type { Page, TestInfo } from "@playwright/test";

const ignoredConsoleErrorPatterns = [
  /favicon\.ico/i,
  /favicon.*failed to load resource/i,
  /favicon.*net::ERR_ABORTED/i,
  /webpack-hmr/i,
  /WebSocket connection .* failed/i,
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
      expectedMissingUrls.some((pattern) => pattern.test(message.location().url))
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
