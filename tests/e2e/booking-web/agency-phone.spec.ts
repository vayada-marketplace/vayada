import { expect, test, type Page } from "@playwright/test";

import { mockAgencyMap } from "../support/agencyMapFake";
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
// search card stays where it is instead of covering the list; a Map button for a full-screen map;
// nothing scrolls sideways.

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
  { layout = { allowed: ["list", "split", "map"], default: "list" }, locale = "" } = {},
) {
  // Every language the app has, for the row's longest words.
  const data = {
    ...agencyPage({ filters, layout }),
    locales: { default: "en", supported: LOCALES },
  };
  await mockAgencyPage(page, { page: data });
  await page.goto(agencyUrl(baseURL, `${locale}/${search}`));
  // Counted by their test ids: a map over the page leaves them out of reach.
  await expect(page.getByTestId("agency-stays").locator("a")).toHaveCount(8);
}
const phoneMap = (page: Page) => page.getByRole("dialog", { name: "Stays on the map" });
const mapButton = (page: Page) => page.getByRole("button", { name: "Map", exact: true });
const pill = (page: Page, name: string) =>
  phoneMap(page)
    .getByRole("region", { name: "Map of the stays" })
    .getByRole("button", { name, exact: true });

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
    await open(page, baseURL, everyFilter, { locale: locale === "en" ? "" : `/${locale}` });
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

test("Map and List: the stays on a full-screen map, a pill's card with View rooms", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  const google = await mockAgencyMap(page);
  await open(page, baseURL);

  // The Map button floats over the list; pressing it is the choice to load Google.
  await cards(page).first().scrollIntoViewIfNeeded();
  await expect(mapButton(page)).toBeVisible();
  expect(google).toHaveLength(0);
  await mapButton(page).click();
  await expect(phoneMap(page)).toBeVisible();
  expect(await phoneMap(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await expect(phoneMap(page)).toContainText("The Travel Ubud · 8 stays");
  await expect(phoneMap(page)).toContainText("2 adults");
  await expect(phoneMap(page).getByRole("button", { name: "Show map" })).toHaveCount(0);
  await expect.poll(() => google.length).toBeGreaterThan(0);
  await expect(phoneMap(page).getByRole("button", { name: "List" })).toBeFocused();
  // A pill per stay with a pin (Adhidrawa has none), with its price per night.
  await expect(
    phoneMap(page).getByRole("region", { name: "Map of the stays" }).getByRole("button"),
  ).toHaveCount(7);
  const escape = pill(page, "The Escape Villa Ubud, from US$95 per night");
  await expect(escape).toHaveText("US$95");

  // A tapped pill opens the stay's card above List, with View rooms for the search.
  await escape.click();
  const card = page.getByTestId("agency-map-card");
  await expect(card).toContainText("The Escape Villa Ubud");
  await expect(card).toContainText("Villa · from US$95 / night");
  await expect(card.getByRole("link", { name: "View rooms" })).toHaveAttribute(
    "href",
    (await page.getByTestId(`agency-stay-${staySlug("escape")}`).getAttribute("href"))!,
  );
  const list = await phoneMap(page).getByRole("button", { name: "List" }).boundingBox();
  const shown = await card.boundingBox();
  expect(shown!.y + shown!.height).toBeLessThan(list!.y);
  expect(shown!.x).toBeGreaterThanOrEqual(0);
  expect(shown!.x + shown!.width).toBeLessThanOrEqual(390);

  // Escape closes the card first, then the map; the focus goes back to the Map button.
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(phoneMap(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(phoneMap(page)).toHaveCount(0);
  await expect(mapButton(page)).toBeFocused();

  // List goes back to the cards too; the map is remembered for the tab.
  await mapButton(page).click();
  await expect(phoneMap(page).getByRole("region", { name: "Map of the stays" })).toBeVisible();
  await phoneMap(page).getByRole("button", { name: "List" }).click();
  await expect(phoneMap(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(8);
  await noSidewaysScroll(page);
  await assertHealthy();
});

test("the agency's Map layout opens a phone on the full-screen map, behind Show map", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  const google = await mockAgencyMap(page);
  await open(page, baseURL, everyFilter, {
    layout: { allowed: ["list", "split", "map"], default: "map" },
  });

  await expect(phoneMap(page)).toBeVisible();
  // Google loads only once the guest asks (VAY-2216).
  await expect(phoneMap(page).getByRole("button", { name: "Show map" })).toBeVisible();
  expect(google).toHaveLength(0);
  await phoneMap(page).getByRole("button", { name: "Show map" }).click();
  await expect(pill(page, "Mertha Carik Guest House, from US$38 per night")).toBeVisible();
  await phoneMap(page).getByRole("button", { name: "List" }).click();
  await expect(cards(page)).toHaveCount(8);
  await cards(page).first().scrollIntoViewIfNeeded();
  await expect(mapButton(page)).toBeVisible();
  await assertHealthy();
});

test("List + map opens a phone on the list with the Map button", async ({ page, baseURL }) => {
  await mockAgencyMap(page);
  await open(page, baseURL, everyFilter, {
    layout: { allowed: ["list", "split"], default: "split" },
  });
  await expect(phoneMap(page)).toHaveCount(0);
  await cards(page).first().scrollIntoViewIfNeeded();
  await expect(mapButton(page)).toBeVisible();
  // The wide screen's layout switch is not on a phone.
  await expect(page.getByRole("group", { name: "Show the accommodations as" })).toHaveCount(0);
});

test("no Map button when the agency allows only the list", async ({ page, baseURL }) => {
  await mockAgencyMap(page);
  await open(page, baseURL, everyFilter, { layout: { allowed: ["list"], default: "list" } });
  await cards(page).first().scrollIntoViewIfNeeded();
  await expect(cards(page)).toHaveCount(8);
  // The button would show once the list is seen on screen: give that a moment first.
  await page.waitForTimeout(800);
  await expect(mapButton(page)).toHaveCount(0);
});

test("the Map button stays clear of the search card's calendar", async ({ page, baseURL }) => {
  await mockAgencyMap(page);
  await open(page, baseURL);
  await cards(page).first().scrollIntoViewIfNeeded();
  await expect(mapButton(page)).toBeVisible();
  // Opened and closed in place: a scroll would hide the button for another reason.
  const dates = page.locator("#stay-search button").first();
  await dates.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(mapButton(page)).toHaveCount(0);
  await dates.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(mapButton(page)).toBeVisible();
});

test("the map closes when the screen turns wide, and doesn't come back", async ({
  page,
  baseURL,
}) => {
  await mockAgencyMap(page);
  await open(page, baseURL, everyFilter, {
    layout: { allowed: ["list", "split", "map"], default: "map" },
  });
  await expect(phoneMap(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(phoneMap(page)).toHaveCount(0);
  // The wide screen opens on its own Map layout.
  await expect(
    page
      .getByRole("group", { name: "Show the accommodations as" })
      .getByRole("button", { name: "Map", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => ({
      inert: document.querySelectorAll("[inert]").length,
      overflow: document.documentElement.style.overflow,
    })),
  ).toEqual({ inert: 0, overflow: "" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await expect(phoneMap(page)).toHaveCount(0);
});
