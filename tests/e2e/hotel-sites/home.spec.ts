import { expect, test, type Page } from "@playwright/test";

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
    for (const id of ["stay", "eat", "about", "contact"]) {
      await expect(
        page.getByRole("navigation", { name: "Main" }).locator(`a[href="#${id}"]`),
      ).toHaveCount(1);
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
    // Nothing wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await loadEveryImage(page);
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

test("shows the four rooms, each card leading to its details, and books through the room list", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#stay").getByRole("link")).toHaveCount(4);
  for (const room of ["Tiger", "Leopard", "Giraffe", "Elephant"]) {
    const id = room.toLowerCase();
    await expect(page.locator(`#stay a[href="#${id}"]`)).toContainText(room, { ignoreCase: true });
    await expect(
      page.locator(`#${id}`).getByRole("heading", { level: 3, name: new RegExp(`^${room}$`, "i") }),
    ).toBeVisible();
  }
  await expect(page.locator('#stay a[href="#elephant"]')).toContainText(/coming soon/i);
  // Until the hotel says which booking rooms are Tiger, Leopard and Giraffe: the whole room list.
  const viewRooms = page.getByRole("link", { name: /^view rooms$/i });
  await expect(viewRooms).toHaveCount(3);
  for (const link of await viewRooms.all()) await expect(link).toHaveAttribute("href", BOOKING_URL);
  await expect(page.locator("#elephant").getByRole("link")).toHaveCount(0);

  await page.locator('#stay a[href="#giraffe"]').click();
  await expect(page.locator("#giraffe")).toBeInViewport();
});

test("switches the gallery's big slide from its thumbnails", async ({ page }) => {
  await page.goto("/");
  const gallery = page.getByRole("region", { name: /beyond your room/i });
  await expect(gallery.getByRole("button")).toHaveCount(8);
  await expect(gallery.getByText("01 / 08")).toBeVisible();
  await expect(
    gallery.getByRole("heading", { level: 3, name: /^sloth mode activated\.$/i }),
  ).toBeVisible();
  const thumb = (name: string) => gallery.getByRole("button", { name: new RegExp(name, "i") });
  await expect(thumb("^01 pool$")).toHaveAttribute("aria-pressed", "true");
  await expect(gallery.getByRole("img", { name: "Pool" })).toBeVisible();

  await thumb("^08 evenings$").click();
  await expect(gallery.getByText("08 / 08")).toBeVisible();
  // Slides 02–08 keep the design's placeholder copy until the client's arrives.
  await expect(
    gallery.getByRole("heading", { level: 3, name: /^\[evenings headline\]$/i }),
  ).toBeVisible();
  await expect(gallery.getByRole("img", { name: "Evenings" })).toBeVisible();
  await expect(thumb("^08 evenings$")).toHaveAttribute("aria-pressed", "true");
  await expect(thumb("^01 pool$")).toHaveAttribute("aria-pressed", "false");
});

test("shows no reviews until real ones are in, and no link the hotel hasn't given", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /loved by our guests/i })).toHaveCount(0);
  // Not even the design's mock-up reviews.
  await expect(page.getByText("A little paradise in Ahangama")).toHaveCount(0);
  for (const name of [
    /read more reviews/i,
    /view menus/i,
    /book a table/i,
    /explore ahangama/i,
    /instagram/i,
  ]) {
    await expect(page.getByRole("link", { name })).toHaveCount(0);
  }
});

test("lays the rooms and gallery out for laptop, tablet and phone", async ({ page }) => {
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const cardRows = async () =>
    new Set(
      await page
        .locator("#stay a")
        .evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().top))),
    ).size;

  // Laptop (1440, the design's width): the four cards in one row, all eight thumbnails in view,
  // Tiger's photo left of its text and Leopard's right of it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  expect(await cardRows()).toBe(1);
  const thumbs = page.locator(".gallery-thumbs");
  expect(await thumbs.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
  expect((await box("#tiger img")).x).toBeLessThan((await box("#tiger h3")).x);
  expect((await box("#leopard img")).x).toBeGreaterThan((await box("#leopard h3")).x);

  // Tablet: two cards a row, never three and a stretched fourth.
  await page.setViewportSize({ width: 1024, height: 900 });
  expect(await cardRows()).toBe(2);

  // Phone: one card a row, and every photo above its text.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await cardRows()).toBe(4);
  for (const id of ["tiger", "leopard", "giraffe", "elephant"]) {
    const image = await box(`#${id} img`);
    expect(image.y + image.height).toBeLessThanOrEqual((await box(`#${id} h3`)).y);
  }
});

// Below-the-fold photos load lazily: scroll through the page, then wait for every one.
async function loadEveryImage(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight / 2) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.waitForFunction(() =>
    Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
  );
}
