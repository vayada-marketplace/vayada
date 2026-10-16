import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// Opt-in suite: build Landing with a public 32-hex test token, then run with
// E2E_LANDING_ANALYTICS=1. It runs offline: Cloudflare's beacon is replaced by a stub generated
// here, and in the JavaScript the browser receives, the app's SRI pin is swapped for the stub's
// hash (test only; the built app keeps the real pin). Whether that pin still matches Cloudflare's
// live file is the job of the scheduled Cloudflare Beacon Drift workflow.
// RUM requests are intercepted: tests never send measurements to Cloudflare.
const source = "https://static.cloudflareinsights.com/beacon.min.js";
const key = "vayada_cookie_consent";
const choice = (analytics: boolean) => ({
  necessary: true,
  functional: false,
  analytics,
  marketing: false,
});
// Stand-in beacon: sends through both guarded transports when it runs, and again on the events
// the real beacon reports (SPA navigation, pagehide, visibilitychange).
const beacon = Buffer.from(`(() => {
  const send = () => {
    navigator.sendBeacon("https://cloudflareinsights.com/cdn-cgi/rum", "{}");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/cdn-cgi/rum");
    xhr.send("{}");
  };
  const push = history.pushState;
  history.pushState = function (...args) {
    push.apply(this, args);
    send();
  };
  addEventListener("pagehide", send);
  document.addEventListener("visibilitychange", send);
  send();
})();`);
const stubIntegrity = `sha384-${createHash("sha384").update(beacon).digest("base64")}`;
const pin = /const integrity = "(sha384-[^"]+)"/.exec(
  readFileSync("apps/landing/lib/cloudflareAnalytics.ts", "utf8"),
)?.[1];
test.skip(process.env.E2E_LANDING_ANALYTICS !== "1", "Requires analytics-enabled Landing build");
test.beforeAll(() => {
  expect(pin, "sha384 pin in apps/landing/lib/cloudflareAnalytics.ts").toBeTruthy();
});
async function intercept(page: Page, { override = true } = {}) {
  const requests: string[] = [];
  if (override) {
    // Test-only override: the app's chunks carry the pin; hand the browser the stub's hash instead.
    await page.route(/\/_next\/static\/.+\.js(\?|$)/, async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const body = (await response.text()).replaceAll(pin!, stubIntegrity);
      await route.fulfill({ response, headers, body });
    });
  }
  await page.route(/cloudflareinsights\.com|\/cdn-cgi\/rum/, async (route) => {
    requests.push(route.request().url());
    if (route.request().url() === source) {
      await route.fulfill({
        body: beacon,
        contentType: "application/javascript",
        headers: { "access-control-allow-origin": "*" },
      });
    } else await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
  });
  return requests;
}
async function withdraw(page: Page) {
  await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
  await page.getByRole("button", { name: /^Necessary only$/i }).click();
}
async function exerciseTransports(page: Page) {
  await page.evaluate(() => {
    for (const url of ["https://cloudflareinsights.com/cdn-cgi/rum", "/cdn-cgi/rum"]) {
      navigator.sendBeacon(url, "{}");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.send("{}");
    }
    history.pushState({}, "", "/privacy");
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(400);
}

test("off before acceptance; actual beacon starts, withdrawal seals the document, reload stays off", async ({
  page,
}) => {
  const requests = await intercept(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Necessary only$/i }).click();
  await page.reload();
  await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await expect(page.locator("script[data-cf-beacon]")).toHaveAttribute("integrity", stubIntegrity);
  await expect
    .poll(() => requests.filter((u) => u.includes("/cdn-cgi/rum")).length)
    .toBeGreaterThan(0);
  await withdraw(page);
  const count = requests.length;
  await exerciseTransports(page);
  expect(requests).toHaveLength(count);
  await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await exerciseTransports(page);
  expect(requests).toHaveLength(count);
  await withdraw(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "Cookie settings", exact: true })).toBeVisible();
  expect(requests).toHaveLength(count);
});

test("cross-tab withdrawal blocks already-open tabs even if acceptance follows immediately", async ({
  page,
  context,
}) => {
  const requests = await intercept(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(1);
  const other = await context.newPage();
  await intercept(other);
  await other.goto("/");
  await other.evaluate(
    ({ key, reject, accept }) => {
      localStorage.setItem(key, JSON.stringify(reject));
      localStorage.setItem(key, JSON.stringify(accept));
    },
    { key, reject: choice(false), accept: choice(true) },
  );
  await expect(page.locator("script[data-cf-beacon]")).toHaveCount(0);
  const count = requests.length;
  await exerciseTransports(page);
  expect(requests).toHaveLength(count);
});

test("withdrawal while beacon is downloading prevents delayed dispatch", async ({ page }) => {
  const requests = await intercept(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(source, async (route) => {
    await gate;
    await route.fulfill({
      body: beacon,
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await expect(page.locator("script[data-cf-beacon]")).toHaveCount(1);
  await withdraw(page);
  release();
  await exerciseTransports(page);
  expect(requests).toEqual([]);
});

test("storage failure stops analytics and preserves unrelated XHR and beacon requests", async ({
  page,
}) => {
  const requests = await intercept(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(1);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage blocked");
    };
  });
  await withdraw(page);
  await expect(page.getByRole("alert").filter({ hasText: "couldn’t save" })).toContainText(
    "couldn’t save",
  );
  const count = requests.length;
  await exerciseTransports(page);
  expect(requests).toHaveLength(count);
  const unrelated: string[] = [];
  await page.route("**/consent-test-required", (route) => {
    unrelated.push(route.request().method());
    return route.fulfill({ status: 204 });
  });
  await page.evaluate(() => {
    navigator.sendBeacon("/consent-test-required", "{}");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/consent-test-required");
    xhr.send("{}");
  });
  await expect.poll(() => unrelated.length).toBe(2);
});

test("unexpected vendor bytes cannot execute", async ({ page }) => {
  const requests = await intercept(page);
  await page.route(source, (route) =>
    route.fulfill({
      body: 'navigator.sendBeacon("/cdn-cgi/rum", "unexpected")',
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
});

test("without the override, the built pin refuses any other beacon bytes", async ({ page }) => {
  const requests = await intercept(page, { override: false });
  await page.goto("/");
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await expect(page.locator("script[data-cf-beacon]")).toHaveAttribute("integrity", pin!);
  await expect.poll(() => requests.includes(source)).toBe(true);
  await page.waitForTimeout(500);
  expect(requests.filter((u) => u.includes("/cdn-cgi/rum"))).toEqual([]);
});

test("failed storage update and removal cannot restore stale acceptance after reload", async ({
  page,
}) => {
  const requests = await intercept(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(1);
  await page.evaluate(() => {
    Storage.prototype.setItem = Storage.prototype.removeItem = () => {
      throw new Error("Storage blocked");
    };
  });
  await withdraw(page);
  const count = requests.length;
  await page.reload();
  await page.getByRole("button", { name: "Cookie settings", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Analytics", exact: true })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  expect(requests).toHaveLength(count);
  await page.getByRole("button", { name: /^Accept all$/i }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(count);
});
