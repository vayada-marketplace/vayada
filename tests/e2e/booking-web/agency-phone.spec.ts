import { expect, test, type Page } from "@playwright/test";

import {
  agencyPage,
  agencyUrl,
  mockAgencyPage,
  searchDates,
  staySlug,
} from "../support/agencyPageMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2463: the agency's booking page on a phone (Timo's mobile prototype, 390 wide). One slim
// row with the stays available, Sort by and Filters; the filters in a sheet from the bottom; the
// search card stays where it is instead of covering the list; nothing scrolls sideways.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const expectedMissingUrls = [
  /\/api\/booking-web\/hotels\/the-travel-ubud(\/checkout-config)?(\?.*)?$/,
];
const { checkIn, checkOut } = searchDates();
const search = `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`;
const everyFilter = {
  propertyType: true,
  area: true,
  price: true,
  privatePool: true,
  breakfast: true,
  freeCancellation: true,
  bedrooms: true,
};

const LOCALES = ["en", "de", "fr", "es", "id"];
const cards = (page: Page) => page.getByTestId("agency-stays").getByRole("link");
const shortCount = (page: Page) => page.getByTestId("agency-count-short");
const filtersButton = (page: Page) => page.getByTestId("agency-filters-button");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Filters" });

async function open(
  page: Page,
  baseURL: string | undefined,
  filters: Record<string, boolean> = everyFilter,
  locale = "",
) {
  // Every language the app has, for the row's longest words.
  const data = { ...agencyPage({ filters }), locales: { default: "en", supported: LOCALES } };
  await mockAgencyPage(page, { page: data });
  await page.goto(agencyUrl(baseURL, `${locale}/${search}`));
  await expect(cards(page)).toHaveCount(8);
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test("one slim row: the stays available, Sort by and Filters, and the search card scrolls away", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL);

  await expect(shortCount(page)).toHaveText("8 stays available");
  // The heading and the long count are the wide screen's; the heading stays for screen readers.
  await expect(page.getByTestId("agency-count")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Available Accommodations" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Available Accommodations" })).toHaveClass(
    /sr-only/,
  );
  // No chips on the page: they are in the sheet.
  await expect(page.getByRole("group", { name: "Filters" })).toHaveCount(0);
  await expect(filtersButton(page)).toHaveText("Filters");
  await expect(filtersButton(page)).toHaveAttribute("aria-expanded", "false");

  // The row fits the phone, and so does the page.
  const row = await Promise.all(
    [shortCount(page), page.getByRole("combobox", { name: "Sort by" }), filtersButton(page)].map(
      (part) => part.boundingBox(),
    ),
  );
  for (const box of row) {
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(Math.abs(box!.y + box!.height / 2 - (row[1]!.y + row[1]!.height / 2))).toBeLessThan(12);
  }
  await noSidewaysScroll(page);

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("price_high");
  await expect(cards(page).first()).toHaveAttribute(
    "data-testid",
    `agency-stay-${staySlug("eskabbe")}`,
  );

  // On a phone the search card stays where it is; it would cover a third of the screen.
  await cards(page).nth(3).scrollIntoViewIfNeeded();
  const card = await page.locator("#stay-search").boundingBox();
  expect(card!.y + card!.height).toBeLessThan(0);
  await assertHealthy();
});

test("the search card still sticks on a wide screen", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, baseURL);
  await cards(page).nth(5).scrollIntoViewIfNeeded();
  const card = await page.locator("#stay-search").boundingBox();
  expect(card!.y).toBeGreaterThanOrEqual(0);
  expect(card!.y).toBeLessThan(40);
  await expect(filtersButton(page)).toBeHidden();
  await expect(shortCount(page)).toBeHidden();
  await expect(page.getByTestId("agency-count")).toContainText("8 of 10 stays are available");
});

test("filters in a sheet: choices apply as they are chosen, Show X stays, Filters (N), Reset", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL);

  await filtersButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toBeFocused();
  await expect(filtersButton(page)).toHaveAttribute("aria-expanded", "true");
  const chips = sheet(page).getByRole("group", { name: "Filters" });
  await expect(chips.getByRole("group", { name: "Property type" }).getByRole("button")).toHaveText([
    "All",
    "Villa",
    "Guest house",
    "Resort",
  ]);
  await expect(chips.getByRole("group", { name: "Area" }).getByRole("button")).toHaveCount(5);
  await expect(sheet(page).getByLabel("Minimum")).toBeVisible();
  for (const name of ["Private pool", "Breakfast included", "Free cancellation"])
    await expect(chips.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Reset" })).toBeDisabled();
  await expect(sheet(page).getByRole("button", { name: "Show 8 stays" })).toBeVisible();
  // The sheet sits on the phone's screen; the page behind is out of reach.
  const box = await sheet(page).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(845);
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(
    await page.locator("#stay-search").evaluate((element) => !!element.closest("[inert]")),
  ).toBe(true);

  await chips.getByRole("button", { name: "Villa", exact: true }).click();
  await expect(sheet(page).getByRole("button", { name: "Show 5 stays" })).toBeVisible();
  // Villas with their own pool: The Escape, D'Wiswan and Eskabbe.
  await chips.getByRole("button", { name: "Private pool", exact: true }).click();
  await sheet(page).getByRole("button", { name: "Show 3 stays" }).click();

  await expect(sheet(page)).toHaveCount(0);
  await expect(filtersButton(page)).toBeFocused();
  await expect(filtersButton(page)).toHaveText("Filters (2)");
  await expect(cards(page)).toHaveCount(3);
  await expect(shortCount(page)).toHaveText("3 stays available");

  // A price range counts once; the fields apply as they are typed.
  await filtersButton(page).click();
  await sheet(page).getByRole("button", { name: "Reset" }).click();
  await expect(sheet(page).getByRole("button", { name: "Show 8 stays" })).toBeVisible();
  await sheet(page).getByLabel("Minimum").fill("100");
  await expect(sheet(page).getByRole("button", { name: "Show 3 stays" })).toBeVisible();
  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(filtersButton(page)).toHaveText("Filters (1)");
  await expect(cards(page)).toHaveCount(3);

  // So does a tap on the dimmed page above it, and the tap goes no further: a stay card is
  // right under the finger.
  await cards(page)
    .nth(1)
    .evaluate((link) => link.scrollIntoView({ block: "start" }));
  const under = await cards(page).nth(1).boundingBox();
  const address = page.url();
  await filtersButton(page).evaluate((button) => (button as HTMLButtonElement).click());
  await expect(sheet(page)).toBeVisible();
  await page.touchscreen.tap(195, under!.y + 60);
  await expect(sheet(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(page.url()).toBe(address);

  // Escape still closes it after Reset turns itself off.
  await filtersButton(page).click();
  await sheet(page).getByRole("button", { name: "Reset" }).click();
  await expect(sheet(page).getByRole("button", { name: "Reset" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // Reset applied at once: every stay is back.
  await filtersButton(page).click();
  await sheet(page).getByRole("button", { name: "Show 8 stays" }).click();
  await expect(filtersButton(page)).toHaveText("Filters");
  await expect(cards(page)).toHaveCount(8);
  await noSidewaysScroll(page);
  await assertHealthy();
});

test("no Filters button when no chip would split the stays", async ({ page, baseURL }) => {
  await open(page, baseURL, {});
  await expect(shortCount(page)).toHaveText("8 stays available");
  await expect(filtersButton(page)).toHaveCount(0);
});

test("the sheet closes when the screen turns wide, and leaves the page as it was", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await filtersButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Filters" })).toBeVisible();
  expect(
    await page.evaluate(() => ({
      inert: document.querySelectorAll("[inert]").length,
      overflow: document.documentElement.style.overflow,
    })),
  ).toEqual({ inert: 0, overflow: "" });
});

for (const locale of LOCALES)
  test(`the slim row fits in ${locale}, with a filter on`, async ({ page, baseURL }) => {
    await open(page, baseURL, everyFilter, locale === "en" ? "" : `/${locale}`);
    // The page really is in that language.
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await filtersButton(page).click();
    // The sheet by its place (its name is the language's), then the property type's first
    // choice after All.
    await page
      .getByTestId("agency-filter-sheet")
      .getByRole("dialog")
      .locator("[role=group] [role=group]")
      .first()
      .getByRole("button")
      .nth(1)
      .click();
    await page.keyboard.press("Escape");
    await expect(filtersButton(page)).toHaveText(/\(1\)$/);
    await page.locator("#stays select").selectOption("recommended");

    const count = await shortCount(page).boundingBox();
    const sort = await page.locator("#stays select").boundingBox();
    const button = await filtersButton(page).boundingBox();
    for (const box of [count, sort, button]) {
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    // Beside Sort, or above it; never under it.
    expect(count!.x + count!.width <= sort!.x || count!.y + count!.height <= sort!.y).toBe(true);
    // No word runs out of the count.
    expect(
      await shortCount(page).evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await noSidewaysScroll(page);
  });
