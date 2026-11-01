import { expect, test } from "@playwright/test";

// VAY-2422: the hotel website template, with Animals Ahangama's homepage.
const BOOKING_URL = "https://test-only-animals-ahangama.next-booking.vayada.com";

for (const width of [1440, 390]) {
  test(`shows the homepage and sends every booking button to the booking page at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    // Script errors and console errors (a failed request, a hydration mismatch).
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/");

    await expect(
      page.getByRole("heading", { level: 1, name: /^a place to land\.$/i }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /^we are all animals\.$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^come stay awhile\.$/i })).toBeVisible();
    const book = page.getByRole("link", { name: /^book your stay$/i });
    await expect(book).toHaveCount(2);
    for (const link of await book.all()) await expect(link).toHaveAttribute("href", BOOKING_URL);
    // The nav's in-page links land on their sections.
    for (const id of ["about", "contact"]) {
      await expect(
        page.getByRole("navigation", { name: "Main" }).locator(`a[href="#${id}"]`),
      ).toHaveCount(1);
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
    // Nothing wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: testInfo.outputPath(`hotel-site-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
}

test("tells search engines and link previews what the page is, and keeps placeholders unindexed", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Animals Ahangama · A place to land");
  const meta = (selector: string) => page.locator(selector).getAttribute("content");
  expect(await meta('meta[name="description"]')).toContain("Ahangama, Sri Lanka");
  expect(await meta('meta[name="robots"]')).toBe("noindex, nofollow");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /^https:\/\/animals-ahangama\.site\.vayada\.com\/?$/,
  );
  expect(await meta('meta[property="og:image"]')).toMatch(
    /^https:\/\/animals-ahangama\.site\.vayada\.com\/_next\/static\/media\/hero\.[\w-]+\.jpg$/,
  );
  const structured = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
  );
  expect(structured).toMatchObject({
    "@type": "Hotel",
    name: "Animals Ahangama",
    address: { addressLocality: "Ahangama", addressCountry: "LK" },
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("answers only on a hotel's own host, except the load balancer's health check", async ({
  page,
  request,
  baseURL,
}) => {
  const other = new URL(baseURL!);
  // Behind portless, 127.0.0.1 reaches the proxy rather than the app.
  test.skip(other.protocol === "https:", "needs the app's own port");
  other.hostname = "127.0.0.1";
  expect((await request.get(other.href)).status()).toBe(404);
  other.pathname = "/api/health";
  const health = await request.get(other.href);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  // The slug is not a path on the site: one address per page. (Through the browser: Node may not
  // resolve *.localhost subdomains.)
  expect((await page.goto("/animals-ahangama"))?.status()).toBe(404);
});
