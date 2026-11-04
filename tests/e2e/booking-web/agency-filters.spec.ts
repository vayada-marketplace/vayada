import { expect, test, type Page } from "@playwright/test";

import {
  agencyPage,
  agencyUrl,
  mockAgencyPage,
  searchDates,
  staySlug,
} from "../support/agencyPageMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2460: the agency page's filter chips. Only the chips the agency switched on show, and only
// while they split its stays; type, area and pool narrow every list, breakfast and free
// cancellation re-price the cards, and the price box keeps a range per night.

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

const cards = (page: Page) => page.getByTestId("agency-stays").getByRole("link");
const order = (page: Page) =>
  cards(page).evaluateAll((links) =>
    links.map((link) => link.getAttribute("data-testid")!.replace(/^agency-stay-/, "")),
  );
const slugs = (...ids: string[]) => ids.map(staySlug);
const filters = (page: Page) => page.getByRole("group", { name: "Filters" });
const chip = (page: Page, name: string) => filters(page).getByRole("button", { name, exact: true });
const count = (page: Page) => page.getByTestId("agency-count");

async function open(page: Page, baseURL: string | undefined, settings = everyFilter) {
  const requests = await mockAgencyPage(page, { page: agencyPage({ filters: settings }) });
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await expect(cards(page)).toHaveCount(8);
  await expect(cards(page).first()).toContainText("from US$38 / night");
  return requests;
}

test("shows only the chips switched on that split the stays; type and area narrow every list", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL);

  // Types and areas, most stays first, each with "All"; then price and the on/off chips. No
  // bedrooms chip: there is no bedroom data yet.
  const types = filters(page).getByRole("group", { name: "Property type" }).getByRole("button");
  await expect(types).toHaveText(["All", "Villa", "Guest house", "Resort"]);
  await expect(types.first()).toHaveAttribute("aria-pressed", "true");
  const areas = filters(page).getByRole("group", { name: "Area" }).getByRole("button");
  await expect(areas).toHaveText([
    "All areas",
    "Ubud",
    "Penestanan",
    "Peliatan",
    "Tegallalang road",
  ]);
  for (const name of ["Price", "Private pool", "Breakfast included", "Free cancellation"])
    await expect(chip(page, name)).toBeVisible();
  await expect(filters(page).getByRole("button")).toHaveCount(13);

  await chip(page, "Guest house").click();
  await expect(chip(page, "Guest house")).toHaveAttribute("aria-pressed", "true");
  expect(await order(page)).toEqual(slugs("mertha", "adhi"));
  await expect(count(page)).toContainText("2 of 2 stays are available");
  // Both full stays are villas.
  await expect(page.getByTestId("agency-full-stays")).toHaveCount(0);

  await chip(page, "Villa").click();
  await expect(cards(page)).toHaveCount(5);
  expect(await order(page)).toEqual(slugs("wiswan", "ranes", "escape", "tamarin", "eskabbe"));
  await expect(cards(page).first()).toContainText("Lowest price");
  await expect(count(page)).toContainText("5 of 7 stays are available");
  await expect(page.getByTestId("agency-full-stays")).toContainText("(2)");

  // Sorting works on what is left.
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("price_high");
  await expect(cards(page).first()).toHaveAttribute(
    "data-testid",
    `agency-stay-${staySlug("eskabbe")}`,
  );

  await chip(page, "Penestanan").click();
  expect(await order(page)).toEqual(slugs("tamarin", "wiswan"));
  await expect(page.getByTestId("agency-full-stays")).toHaveCount(0);

  await chip(page, "All").click();
  await chip(page, "All areas").click();
  await expect(cards(page)).toHaveCount(8);
  await expect(count(page)).toContainText("8 of 10 stays are available");
  await assertHealthy();
});

test("Breakfast included and Free cancellation re-price the cards and leave out stays without", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  const requests = await open(page, baseURL);
  const searches = requests.length;

  await chip(page, "Breakfast included").click();
  await expect(chip(page, "Breakfast included")).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(5);
  expect(await order(page)).toEqual(slugs("mertha", "ranes", "escape", "mandala", "eskabbe"));
  const first = cards(page).first();
  await expect(first).toContainText("from US$45 / night");
  await expect(first).toContainText("from US$90 total");
  await expect(first).toContainText("1 room type free · fits 2 adults");
  await expect(first).toContainText("Lowest price");
  await expect(count(page)).toContainText("5 of 10 stays are available");
  // Full stays have no rates for these dates: they stay listed.
  await expect(page.getByTestId("agency-full-stays")).toContainText("(2)");

  // Both: The Escape and Eskabbe have rates with breakfast that are free to cancel.
  await chip(page, "Free cancellation").click();
  expect(await order(page)).toEqual(slugs("escape", "eskabbe"));
  await expect(cards(page).first()).toContainText("from US$125 / night");

  await chip(page, "Breakfast included").click();
  expect(await order(page)).toEqual(slugs("wiswan", "escape", "eskabbe"));
  await expect(cards(page).nth(1)).toContainText("from US$105 / night");

  await chip(page, "Free cancellation").click();
  await expect(cards(page)).toHaveCount(8);
  await expect(cards(page).first()).toContainText("from US$38 / night");
  // Filters work on the answer the page has: no new searches.
  expect(requests).toHaveLength(searches);
  await assertHealthy();
});

test("the price box keeps a range per night, and Reset filters ends an empty result", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL);

  await chip(page, "Price").click();
  const box = page.getByRole("group", { name: "Price per night in USD" });
  await expect(box.getByLabel("Minimum")).toHaveAttribute("placeholder", "38");
  await expect(box.getByLabel("Maximum")).toHaveAttribute("placeholder", "160");
  await box.getByLabel("Maximum").fill("80");
  expect(await order(page)).toEqual(slugs("mertha", "adhi", "wiswan"));
  await expect(chip(page, "Up to US$80")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  // The focus goes back to the chip.
  await expect(chip(page, "Up to US$80")).toBeFocused();

  await chip(page, "Private pool").click();
  expect(await order(page)).toEqual(slugs("wiswan"));

  // A resort with a pool for at most US$80 a night: none.
  await chip(page, "Resort").click();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByText("No stay matches these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(cards(page)).toHaveCount(8);
  await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "Price")).toBeVisible();
  await expect(chip(page, "Private pool")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("No stay matches these filters.")).toHaveCount(0);

  // A range belongs to the currency it was typed in: another display currency starts without.
  await chip(page, "Price").click();
  await box.getByLabel("Maximum").fill("80");
  await expect(cards(page)).toHaveCount(3);
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "USD", exact: true }).click();
  await nav.getByRole("button", { name: /Euro/ }).click();
  await expect(chip(page, "Price")).toBeVisible();
  await expect(cards(page)).toHaveCount(8);
  await assertHealthy();
});

test("shows only the chips the agency switched on", async ({ page, baseURL }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL, {
    ...everyFilter,
    area: false,
    price: false,
    privatePool: false,
    freeCancellation: false,
  });
  await expect(filters(page).getByRole("button")).toHaveText([
    "All",
    "Villa",
    "Guest house",
    "Resort",
    "Breakfast included",
  ]);
  await assertHealthy();
});

test("shows no filter row when the agency switched every chip off", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await mockAgencyPage(page);
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await expect(cards(page)).toHaveCount(8);
  await expect(cards(page).first()).toContainText("from US$38 / night");
  await expect(filters(page)).toHaveCount(0);
  await assertHealthy();
});
