import { expect, test, type Page, type Route } from "@playwright/test";

import { corsHeaders, fulfillCorsPreflight } from "../support/cors";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2286: the contact form posts to the contact intake of the TypeScript API (next-api in
// production). Without NEXT_PUBLIC_API_URL the landing falls back to the local apps/api host.
const apiOrigin = new URL(process.env.NEXT_PUBLIC_API_URL || "https://api.localhost").origin;

type ContactPost = { url: string; body: unknown };

async function mockContactIntake(
  page: Page,
  answer: (route: Route) => Promise<void>,
): Promise<ContactPost[]> {
  const posts: ContactPost[] = [];
  await page.route(/\/contact$/, async (route) => {
    const request = route.request();
    if (request.resourceType() === "document") return route.fallback();
    if (request.method() === "OPTIONS") return fulfillCorsPreflight(route);
    posts.push({ url: request.url(), body: request.postDataJSON() });
    await answer(route);
  });
  return posts;
}

async function openAndSendContactForm(page: Page) {
  // A stored "necessary only" choice keeps the cookie banner off the submit button.
  await page.addInitScript(() =>
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: false, analytics: false, marketing: false }),
    ),
  );
  await page.goto("/contact");
  // Controlled inputs: fill only after hydration so React does not reset the values.
  await page.waitForLoadState("networkidle");
  const form = page.locator("form");
  await form.locator('input[name="name"]').fill("Ana Host");
  await form.locator('input[name="email"]').fill("ana@example.com");
  await form.locator('input[name="company"]').fill("Casa Ana");
  await form.locator('select[name="userType"]').selectOption("hotel");
  await form.locator('textarea[name="message"]').fill("We have 12 rooms and want direct bookings.");
  await form.getByRole("button", { name: "Book a Demo" }).click();
  return form;
}

test.describe("landing contact form", () => {
  test("sends the message to the API contact intake and confirms it", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const posts = await mockContactIntake(page, (route) =>
      route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        body: JSON.stringify({ status: "accepted", intakeId: "contact_e2e" }),
      }),
    );

    const form = await openAndSendContactForm(page);

    await expect(page.getByText("Thank you! We've received your message")).toBeVisible();
    expect(posts).toHaveLength(1);
    const url = new URL(posts[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${apiOrigin}/api/contact`);
    expect(posts[0].body).toEqual({
      name: "Ana Host",
      email: "ana@example.com",
      company: "Casa Ana",
      user_type: "hotel",
      message: "We have 12 rooms and want direct bookings.",
    });
    await expect(form.locator('input[name="name"]')).toHaveValue("");

    await assertHealthy();
  });

  test("shows the intake's reason and keeps the draft when it refuses", async ({ page }) => {
    // The 429 is the intended answer here, so page health (which fails on console errors) is off.
    await mockContactIntake(page, (route) =>
      route.fulfill({
        status: 429,
        headers: { ...corsHeaders(route), "retry-after": "42" },
        body: JSON.stringify({
          code: "rate_limited",
          category: "rate_limit",
          message: "Too many messages in a short time. Please wait a minute and try again.",
          statusCode: 429,
        }),
      }),
    );

    const form = await openAndSendContactForm(page);

    await expect(page.getByText("Too many messages in a short time.")).toBeVisible();
    await expect(page.getByText("Thank you!")).toHaveCount(0);
    await expect(form.locator('input[name="name"]')).toHaveValue("Ana Host");
    await expect(form.locator('textarea[name="message"]')).toHaveValue(
      "We have 12 rooms and want direct bookings.",
    );
  });
});
