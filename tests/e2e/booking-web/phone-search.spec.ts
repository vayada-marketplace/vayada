import { inflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, mockStayPrices, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2494 (Timo's "Proposal – Card overlaps hero" and "Proposal – scrolled"): the top of the
// hotel page on a phone. A 420px hero with its text 28px above the card, which overlaps it by
// 64px without dark strips beside it; dates and guests are two 64px rows, the promo a 44px row
// under a 54px button; "Available stays" (32px) has a found line and a small Sort beside its foot
// that opens a sheet, 20px above the rooms; a 102px bar with the hotel's name and the stay takes
// over once the card scrolls away. From `md` up nothing changes, except that the card now sticks.
const key = (letter: string) => `pricing-offer.v2:${letter.repeat(64)}`;
const STAY = "/?checkIn=2026-11-13&checkOut=2026-11-14&adults=2";
const ROOMS = [
  { id: "small", guests: 2, size: 20, total: "20000" },
  { id: "large", guests: 4, size: 45, total: "30000" },
  { id: "mid", guests: 3, size: 30, total: "25000" },
] as const;

async function open(page: Page, path = STAY) {
  await page.clock.setFixedTime(new Date("2026-11-12T08:00:00Z"));
  // Analytics already answered: nothing here waits for the question.
  await page.addInitScript(
    ({ slug, version }) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version, analytics: false }),
      ),
    { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
  );
  await mockBookingApis(page, {
    primaryColor: "#c19a76",
    headerSettings: {
      showContactButton: true,
      showReferAGuestButton: false,
      showLanguageSelector: true,
      showCurrencySelector: true,
    },
  });
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: ROOMS.map((room, i) => ({
          roomTypeId: room.id,
          name: `${room.id[0]!.toUpperCase()}${room.id.slice(1)} Villa`,
          occupancy: { maxGuests: room.guests, maxAdults: room.guests, maxChildren: 0 },
          size: { value: room.size, unit: "sqm" },
          offers: [
            {
              publicOfferKey: key("abc"[i]!),
              currency: "EUR",
              mealPlan: "room_only",
              cancellation: { kind: "free_until_days_before_arrival", days: 3 },
              paymentMethods: ["card"],
            },
          ],
        })),
      },
    }),
  );
  await mockStayPrices(
    page,
    Object.fromEntries(ROOMS.map((room, i) => [room.id, { [key("abc"[i]!)]: room.total }])),
  );
  await page.goto(path);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await expect(page.locator('[data-testid^="room-card-"]')).toHaveCount(ROOMS.length);
}

const box = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!;

/** The colour of one screen pixel, read from a 1px screenshot (the first pixel of a PNG's first
 * row is stored as is, whatever its filter). */
async function pixel(page: Page, x: number, y: number) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1]!, raw[2]!, raw[3]!];
}

const order = (page: Page) =>
  page
    .locator('[data-testid^="room-card-"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-testid")!.replace("room-card-", "")),
    );

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the card overlaps the hero without dark strips, with two rows and a small promo link", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await open(page);
    const hero = await page
      .locator("#stay-search")
      .evaluate((el) => el.previousElementSibling!.getBoundingClientRect().toJSON());
    const card = await box(page, "#stay-search > div");
    expect(Math.round(hero.height)).toBe(420);
    expect(Math.round(hero.bottom - card.y)).toBe(64);
    expect(card.x).toBe(16);
    expect(card.width).toBe(358);
    await expect(page.locator("#stay-search > div")).toHaveCSS("border-top-left-radius", "20px");
    // The hero's heading and line sit low, 28px above the card.
    const text = await page
      .locator("h1")
      .first()
      .evaluate((h1) => h1.parentElement!.lastElementChild!.getBoundingClientRect().bottom);
    expect(Math.round(card.y - text)).toBe(28);
    // Left and right of the card, the photo has faded into the page instead of a dark band.
    for (const x of [4, 385]) {
      const [r, g, b] = await pixel(page, x, hero.bottom - 6);
      expect(Math.min(r, g, b), `pixel at ${x}`).toBeGreaterThan(200);
    }

    // Dates: one line without this year, the nights on the right; guests below.
    const dates = page.getByTestId("phone-stay-dates");
    await expect(dates).toHaveText("Fri 13 Nov → Sat 14 Nov");
    const lines = await dates.evaluate(
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
    );
    expect(lines).toBeLessThan(1.5);
    const datesRow = page.locator("#stay-search button").first();
    await expect(datesRow).toContainText("1 night");
    const guestsRow = page.locator("#stay-search button").nth(1);
    await expect(guestsRow).toContainText("2 adults");
    const [d, g] = [(await datesRow.boundingBox())!, (await guestsRow.boundingBox())!];
    expect(g.y).toBeGreaterThan(d.y + d.height);
    expect(Math.abs(g.width - d.width)).toBeLessThan(2);
    expect(Math.round(d.height)).toBe(64);
    expect(Math.round(g.height)).toBe(64);
    await expect(datesRow.getByText("Dates", { exact: true })).toHaveCSS(
      "text-transform",
      "uppercase",
    );

    // Check Availability spans the card, white on the brand colour (VAY-2486); the promo is a
    // small link under it.
    const check = page.getByRole("button", { name: "Check Availability", exact: true });
    const c = (await check.boundingBox())!;
    expect(c.width).toBeGreaterThan(320);
    expect(Math.round(c.height)).toBe(54);
    await expect(check).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(check).toHaveCSS("font-size", "19px");
    const promo = page.getByRole("button", { name: "Add promo code" });
    await expect(promo).toBeVisible();
    const p = (await promo.boundingBox())!;
    expect(p.y).toBeGreaterThan(c.y + c.height);
    expect(Math.round(p.height)).toBe(44);
    await expect(promo.locator("svg")).toBeVisible();
    await expect(promo.locator("span:visible")).toHaveCSS("font-size", "15px");
    await expect(promo.locator("span:visible")).toHaveCSS("text-decoration-line", "none");

    // The top bar as it was: Contact, the language and the currency.
    const nav = page.locator("nav");
    await expect(nav.getByRole("button", { name: "Contact", exact: true })).toBeVisible();
    await expect(nav.getByText("EN", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(nav.getByText("EUR", { exact: true }).filter({ visible: true })).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({ path: testInfo.outputPath("phone-top.png"), animations: "disabled" });

    // It scrolls away with the page.
    await page.evaluate(() => window.scrollTo(0, 700));
    const scrolled = await box(page, "#stay-search");
    expect(scrolled.y + scrolled.height).toBeLessThan(0);
    await assertHealthy();
  });

  test("shows the year of a stay in another year", async ({ page }) => {
    await open(page, "/?checkIn=2027-01-05&checkOut=2027-01-07&adults=2");
    await expect(page.getByTestId("phone-stay-dates")).toHaveText(
      "Tue, 5 Jan 2027 → Thu, 7 Jan 2027",
    );
    await expect(page.getByTestId("rooms-found")).toHaveText(
      /^3 options · 5\s*–\s*7 Jan 2027 · 2 adults$/,
    );
  });

  test("Available stays on one line with what the search found, and the sort in a sheet", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await open(page);
    const heading = page.getByRole("heading", { name: "Available stays" });
    const found = page.getByTestId("rooms-found");
    const [h, column, card, f, first] = [
      (await heading.boundingBox())!,
      (await heading.locator("..").boundingBox())!,
      await box(page, "#stay-search"),
      (await found.boundingBox())!,
      await box(page, '[data-testid^="room-card-"]'),
    ];
    await expect(heading).toHaveCSS("font-size", "32px");
    const lineHeight = await heading.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(h.height).toBeLessThan(lineHeight * 1.5);
    // The heading's column starts 36px under the search card; the rooms 20px under it.
    expect(Math.round(column.y - (card.y + card.height))).toBe(36);
    expect(f.y).toBeGreaterThan(h.y + h.height);
    expect(Math.round(first.y - (column.y + column.height))).toBe(20);
    // The range as the browser's Intl writes it ("13 – 14 Nov", with thin spaces).
    await expect(found).toHaveText(/^3 options · 13\s*–\s*14 Nov · 2 adults$/);

    // The sort beside the column's foot, level with the found line's bottom.
    const sort = page.getByRole("button", { name: "Sort", exact: true });
    const s = (await sort.boundingBox())!;
    expect(Math.abs(s.y + s.height - (column.y + column.height))).toBeLessThan(2);
    expect(s.x).toBeGreaterThan(h.x + h.width);
    expect(s.x + s.width).toBeLessThanOrEqual(374);
    await expect(sort).toHaveCSS("font-size", "15px");
    await expect(page.getByRole("combobox", { name: "Sort by" })).toBeHidden();

    await sort.click();
    const sheet = page.getByRole("dialog", { name: "Sort by" });
    await expect(sheet.locator("button[aria-pressed]")).toHaveText([
      "Recommended",
      "Price: Low to High",
      "Price: High to Low",
      "Room size: Largest first",
    ]);
    await expect(sheet.getByRole("button", { name: "Recommended" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.screenshot({ path: testInfo.outputPath("phone-sort-sheet.png") });
    await sheet.getByRole("button", { name: "Price: High to Low" }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => order(page)).toEqual(["large", "mid", "small"]);
    await expect(sort).toBeFocused();

    // Escape closes it as it was.
    await sort.click();
    await expect(sheet.getByRole("button", { name: "Price: High to Low" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect.poll(() => order(page)).toEqual(["large", "mid", "small"]);
    await assertHealthy();
  });

  test("a compact bar takes over once the card has scrolled away", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await open(page);
    const bar = page.getByTestId("sticky-search-bar");
    await expect(bar).toHaveCount(0);

    // Check Availability: the heading right under the bar.
    await page.getByRole("button", { name: "Check Availability", exact: true }).click();
    await expect(bar).toBeVisible();
    await expect
      .poll(
        async () => (await page.getByRole("heading", { name: "Available stays" }).boundingBox())!.y,
      )
      .toBeGreaterThanOrEqual(102);

    await page.getByTestId("room-card-mid").scrollIntoViewIfNeeded();
    await expect(bar).toBeVisible();
    expect(await bar.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 102 });
    // The hotel's name on top, then the stay in a 48px pill with Edit, and the round sort.
    await expect(bar.getByText("Hotel Alpenrose", { exact: true })).toBeVisible();
    const edit = bar.getByRole("button", { name: /13\s*–\s*14 Nov · 2 adults.*Edit/ });
    await expect(edit).toBeVisible();
    expect(Math.round((await edit.boundingBox())!.height)).toBe(48);
    const barSort = (await bar.getByRole("button", { name: "Sort", exact: true }).boundingBox())!;
    expect([Math.round(barSort.width), Math.round(barSort.height)]).toEqual([48, 48]);
    await page.screenshot({ path: testInfo.outputPath("phone-scrolled.png") });

    // Its sort is the heading's.
    await bar.getByRole("button", { name: "Sort", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Sort by" });
    await sheet.getByRole("button", { name: "Room size: Largest first" }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => order(page)).toEqual(["large", "mid", "small"]);

    // Edit: back to the card, with the dates open.
    await edit.click();
    await expect(page.getByText("Select your dates")).toBeVisible();
    await expect(page.locator("#stay-search")).toBeInViewport();
    await expect(bar).toHaveCount(0);
    // While a panel is open the bar waits, even with the card scrolled away: it never covers it.
    await page.evaluate(() => window.scrollBy(0, 700));
    await expect(page.getByText("Select your dates")).toBeAttached();
    await expect(bar).toHaveCount(0);
    await assertHealthy();
  });
});

for (const width of [768, 1440]) {
  test(`keeps the search and the sort as they were at ${width}px, and the card now sticks`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Sort by" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sort", exact: true })).toBeHidden();
    await expect(page.getByTestId("rooms-found")).toBeHidden();
    await expect(page.getByRole("button").filter({ hasText: "Your Stay" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add promo", exact: true })).toBeVisible();

    await page.getByTestId("room-card-mid").scrollIntoViewIfNeeded();
    // The overflow fix: `sticky top-4` holds from `md` up.
    await expect.poll(async () => Math.round((await box(page, "#stay-search")).y)).toBe(16);
    await expect(page.getByTestId("sticky-search-bar")).toHaveCount(0);
    await assertHealthy();
  });
}
