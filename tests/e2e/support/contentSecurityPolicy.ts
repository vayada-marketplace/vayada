import { expect, type Page, type Response } from "@playwright/test";

// VAY-2516: PMS and Booking Admin send a report-only Content-Security-Policy with a fresh nonce per
// page, and an enforced frame-ancestors 'none' plus X-Frame-Options: DENY.

/**
 * Collects every CSP violation the page raises, report-only ones included, from its first byte.
 * Images and files on the mocks' made-up hosts (example.com, *.example, *.test) exist only in the
 * specs and are left out.
 */
export async function watchCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      let host = "";
      try {
        host = new URL(event.blockedURI).hostname;
      } catch {
        // "inline", "eval" and other keywords have no host.
      }
      if (/(^|\.)example(\.com)?$|\.test$/.test(host)) return;
      // Next's browser polyfill for Node's util tries `Function("return function*() {}")` once to see
      // whether generators exist, and copes when it's blocked. It comes with node:crypto imports in the
      // browser bundles; VAY-2595 removes them before the policy is enforced.
      const sample = event.sample.replace(/\s+/g, " ");
      if (event.blockedURI === "eval" && sample === "(function anonymous( ) { return function")
        return;
      seen.push(
        `${event.effectiveDirective} blocked ${event.blockedURI} (${event.disposition}) at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`,
      );
    });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    );
}

/** The page's headers, and Next's own scripts carry the nonce the policy names. */
export async function expectCspOnPage(page: Page, response: Response | null) {
  expect(response, "page response").not.toBeNull();
  const headers = response!.headers();
  const policy = headers["content-security-policy-report-only"] ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
  expect(nonce, "report-only policy with a nonce").toBeTruthy();
  expect(policy).toContain("'strict-dynamic'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");

  // Every script tag the server rendered carries the nonce; the ones they load later need none.
  const scriptTags = (await response!.text()).match(/<script\b[^>]*>/g) ?? [];
  expect(scriptTags.length, "Next's scripts").toBeGreaterThan(0);
  expect(scriptTags.filter((tag) => !tag.includes(`nonce="${nonce}"`))).toEqual([]);
}

/**
 * A page on another origin that frames `url` gets an error page in that frame, while a page without
 * frame protection loads in a frame next to it. The framing page is served on the other loopback
 * name of the same machine: Chromium won't let a public origin frame a loopback page at all, which
 * would pass this check for the wrong reason.
 */
export async function expectNotFrameable(page: Page, url: string) {
  const headers = (await page.request.get(url)).headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");

  const target = new URL(url);
  const control = new URL("/__frameable", target);
  const framingSite = new URL("/__framing-site", target);
  framingSite.hostname = target.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  await page.route(control.toString(), (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>frameable</p>" }),
  );
  await page.route(framingSite.toString(), (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe id="control" src="${control}"></iframe><iframe id="app" src="${url}"></iframe>`,
    }),
  );
  // Waits for the load event, which waits for both frames.
  await page.goto(framingSite.toString());

  await expect(page.frameLocator("#control").locator("p")).toHaveText("frameable");
  const appFrame = await (await page.locator("#app").elementHandle())?.contentFrame();
  expect(appFrame?.url()).toMatch(/^(chrome-error:|about:blank)/);
  const appScripts = await appFrame
    ?.evaluate(() => document.querySelectorAll("script[src*='/_next/']").length)
    .catch(() => 0);
  expect(appScripts ?? 0).toBe(0);
}
