import { expect, test, type Page } from "@playwright/test";

// VAY-2422: the hotel website template, with Animals Ahangama's homepage.
const BOOKING_URL = "https://animals-ahangama.next-booking.vayada.com";
// hero.<hash>.jpg at 640px wide, quality 75, as AVIF (apps/hotel-sites/components/photo-files.mjs).
// Next's hashes can hold dots and tildes.
const PHOTO_FILE = /^\/_next\/static\/media\/[^/]+\.\d+w\.q75\.avif$/;

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
    // Every photo is a file the build converted, the AVIF one at a srcset width: no image server.
    const photos = await page.evaluate(() =>
      Array.from(document.images, (image) => new URL(image.currentSrc).pathname),
    );
    expect(photos.length).toBeGreaterThan(0);
    for (const photo of photos) expect(photo).toMatch(PHOTO_FILE);
    await page.screenshot({
      path: testInfo.outputPath(`hotel-site-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
}

test("tells search engines and link previews what the page is, and lets them index the site", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Animals Ahangama · A place to land");
  const meta = (selector: string) => page.locator(selector).getAttribute("content");
  expect(await meta('meta[name="description"]')).toContain("Ahangama, Sri Lanka");
  expect(await meta('meta[name="robots"]')).toBe("index, follow");
  // No noindex header on any file either, so the photos can show in image search; and build files
  // are kept for good (the host folder's _headers, applied as Cloudflare Pages will).
  const headers = await page.evaluate(async () => {
    const [home, photo] = await Promise.all([
      fetch("/"),
      fetch(document.querySelector("img")!.src),
    ]);
    return {
      page: home.headers.get("x-robots-tag"),
      photo: photo.headers.get("x-robots-tag"),
      photoCache: photo.headers.get("cache-control"),
    };
  });
  expect(headers).toEqual({
    page: null,
    photo: null,
    photoCache: "public, max-age=31536000, immutable",
  });
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /^https:\/\/animals-ahangama\.site\.vayada\.com\/?$/,
  );
  expect(await meta('meta[property="og:image"]')).toMatch(
    /^https:\/\/animals-ahangama\.site\.vayada\.com\/_next\/static\/media\/hero\.[^/]+\.jpg$/,
  );
  const structured = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
  );
  expect(structured).toMatchObject({
    "@type": "Hotel",
    name: "Animals Ahangama",
    address: { addressLocality: "Ahangama", addressCountry: "LK" },
    telephone: "+94 74 028 5070",
    email: "animalsahangama@gmail.com",
    sameAs: ["https://www.instagram.com/animalsahangama/"],
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("serves the hotel's page at / of its own address, and a 404 for anything else", async ({
  page,
  request,
  baseURL,
}) => {
  // The build has one folder per hotel address; another address has none.
  const other = new URL(baseURL!);
  other.hostname = "127.0.0.1";
  expect((await request.get(other.href)).status()).toBe(404);
  // The slug is not a path on the site: one address per page. (Through the browser: Node may not
  // resolve *.localhost subdomains.)
  expect((await page.goto("/animals-ahangama"))?.status()).toBe(404);
  expect((await page.goto("/no-such-page"))?.status()).toBe(404);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});

test("shows the four rooms, each card leading to its details, each booking button to its rooms", async ({
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
  // The hotel's match (VAY-2465): Rooms 1–4 are Tiger, 5–7 Leopard, 8–11 Giraffe. "View rooms" opens
  // the first one's details on the booking page, over its room list.
  await expect(page.getByRole("link", { name: /^view rooms$/i })).toHaveCount(3);
  for (const [id, roomTypeId] of [
    ["tiger", "70af6ad4-555d-43be-b387-9f6b46845199"], // Room 1
    ["leopard", "3a14bd50-2093-4ebc-a1c4-8d66aea0f4a5"], // Room 5
    ["giraffe", "bf7edd9f-455d-4cfc-8815-c7362f2b7b9c"], // Room 8
  ] as const) {
    await expect(
      page.locator(`#${id}`).getByRole("link", { name: /^view rooms$/i }),
    ).toHaveAttribute("href", `${BOOKING_URL}/?room=${roomTypeId}`);
  }
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
  await expect(gallery.getByRole("img", { name: /^a guest resting in the pool/i })).toBeVisible();

  await thumb("^08 evenings$").click();
  await expect(gallery.getByText("08 / 08")).toBeVisible();
  // The hotel's own slide texts and photos (VAY-2465).
  await expect(
    gallery.getByRole("heading", { level: 3, name: /^evenings at animals$/i }),
  ).toBeVisible();
  await expect(
    gallery.getByText("Warm lights, good music and stories from the day.", { exact: true }),
  ).toBeVisible();
  await expect(gallery.getByRole("img", { name: /^guests at dinner/i })).toBeVisible();
  // The new slide's photo loads: the build made its AVIF file at every width the slide asks for.
  const slide = gallery.locator(".gallery-slide img");
  await slide.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      slide.evaluate((image: HTMLImageElement) =>
        image.complete && image.naturalWidth > 0 ? new URL(image.currentSrc).pathname : "",
      ),
    )
    .toMatch(/\/evenings\.[^/]+\.\d+w\.q75\.avif$/);
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
  for (const name of [/read more reviews/i, /view menus/i, /book a table/i, /explore ahangama/i]) {
    await expect(page.getByRole("link", { name })).toHaveCount(0);
  }
});

for (const width of [1440, 390]) {
  test(`shows the hotel's phone, WhatsApp, email and Instagram where the nav's Contact jumps at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).locator('a[href="#contact"]').click();
    const footer = page.locator("footer#contact");
    await expect(footer).toBeInViewport();
    const contact = footer.locator("address");
    await expect(contact.getByRole("link")).toHaveCount(4);
    for (const [name, href] of [
      ["+94 74 028 5070", "tel:+94740285070"],
      ["WhatsApp", "https://wa.me/94740285070"],
      ["animalsahangama@gmail.com", "mailto:animalsahangama@gmail.com"],
      ["Instagram", "https://www.instagram.com/animalsahangama/"],
    ] as const) {
      const link = contact.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", href);
    }
    // Each link fits on the screen, the long email address included.
    for (const link of await contact.getByRole("link").all()) {
      const box = (await link.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  });
}

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
  // The photo's <picture> adds no box or gap: the card starts with its photo.
  expect((await box('#stay a[href="#tiger"] img')).y).toBe((await box('#stay a[href="#tiger"]')).y);
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
