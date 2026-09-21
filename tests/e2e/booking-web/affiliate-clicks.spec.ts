import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

test("removes an unhandled affiliate reference before the hotel page renders", async ({ page }) => {
  await mockBookingApis(page);
  const requests: Array<{ url: string; referrer: string }> = [];
  page.on("request", (request) =>
    requests.push({ url: request.url(), referrer: request.headers()["referer"] ?? "" }),
  );
  await page.goto("/?vref=vc_test-reference&checkIn=2026-10-01");
  await expect(page).toHaveURL(/\?checkIn=2026-10-01$/);
  const referenceRequests = requests.filter(({ url }) => url.includes("vref="));
  expect(referenceRequests).toHaveLength(1);
  expect(new URL(referenceRequests[0]!.url).pathname).toBe("/");
  expect(requests.every(({ referrer }) => !referrer.includes("vref="))).toBe(true);
});

for (const navigation of ["history", "document"] as const) {
  test(`retains A → B → A in one session across ${navigation} navigation`, async ({ page }) => {
    await page.addInitScript((slug) => {
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version: 1, analytics: true }),
      );
    }, SEEDED_BOOKING_SLUG);
    const sessions = new Set<string>();
    await mockBookingApis(page);
    const clicks = new Map<string, string>();
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/attribution/clicks`,
      async (route) => {
        const body = route.request().postDataJSON();
        expect(body.clickId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        clicks.set(body.clickId, body.referralCode);
        expect(body.sessionId).toBeTruthy();
        sessions.add(body.sessionId);
        await route.fulfill({ status: 204 });
      },
    );
    await page.goto("/?ref=A");
    await expect.poll(() => [...clicks.values()]).toEqual(["A"]);
    if (navigation === "history")
      await page.evaluate(() => window.history.pushState(null, "", "?ref=B"));
    else await page.goto("/?ref=B");
    await expect.poll(() => [...clicks.values()]).toEqual(["A", "B"]);
    if (navigation === "history")
      await page.evaluate(() => window.history.pushState(null, "", "?ref=A"));
    else await page.goto("/?ref=A");
    await expect.poll(() => [...clicks.values()]).toEqual(["A", "B", "A"]);
    expect(sessions.size).toBe(1);
  });
}
