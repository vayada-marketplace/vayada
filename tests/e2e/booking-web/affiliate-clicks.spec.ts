import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

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
