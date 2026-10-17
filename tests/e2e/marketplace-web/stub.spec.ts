import { expect, test } from "@playwright/test";

// VAY-2270: marketplace-web is a redirect stub until its service goes (step 4). The targets match
// the dev server's env in playwright.config.ts and the PR Checks job.
const bookingAdminUrl = (
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "http://admin.booking.localhost:3003"
).replace(/\/+$/, "");
const marketingUrl = (process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com").replace(
  /\/+$/,
  "",
);

test.describe("marketplace-web redirect stub", () => {
  test("health answers for the load balancer", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  for (const [path, destination] of [
    [
      "/setup?propertyId=abc&entryProduct=booking",
      `${bookingAdminUrl}/setup?propertyId=abc&entryProduct=booking`,
    ],
    ["/setup/airbnb-return/p1/s1?state=x", `${bookingAdminUrl}/setup/airbnb-return/p1/s1?state=x`],
    ["/invite?code=VAY-123", `${bookingAdminUrl}/invite?code=VAY-123`],
    ["/login", `${bookingAdminUrl}/login`],
    ["/signup", `${bookingAdminUrl}/signup`],
    ["/verify-email?token=t", `${bookingAdminUrl}/verify-email?token=t`],
    ["/settings/privacy", `${bookingAdminUrl}/settings/privacy`],
    ["/settings/delete-account", `${bookingAdminUrl}/settings/privacy`],
    ["/handoff", `${bookingAdminUrl}/login`],
    ["/onboarding", `${bookingAdminUrl}/signup`],
    ["/", marketingUrl],
    ["/creators", marketingUrl],
    ["/marketplace", marketingUrl],
    ["/profile/complete", marketingUrl],
    ["/hotels/some-hotel", marketingUrl],
  ] as const) {
    test(`${path} forwards to ${destination}`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([302, 307, 308]).toContain(response.status());
      expect(response.headers()["location"]).toBe(destination);
    });
  }

  test("an unknown old route forwards to the marketing site", async ({ page }) => {
    await page.goto("/some-forgotten-page");
    await expect.poll(() => new URL(page.url()).origin).toBe(new URL(marketingUrl).origin);
  });
});
