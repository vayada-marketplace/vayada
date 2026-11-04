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

// VAY-2460: the agency page's List + map and Map layouts. Only the layouts the agency allows show,
// starting on its default; one pill per stay with its from-price; a stay's card and pill stand out
// together; a pill opens the stay's small card; and Google loads only after the guest's consent.

const expectedMissingUrls = [
  /\/api\/booking-web\/hotels\/the-travel-ubud(\/checkout-config)?(\?.*)?$/,
];
const { checkIn, checkOut } = searchDates();
const search = `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`;
const all = ["list", "split", "map"];

const layouts = (page: Page) => page.getByRole("group", { name: "Show the accommodations as" });
const map = (page: Page) => page.getByRole("region", { name: "Map of the stays" });
const pill = (page: Page, name: string) => map(page).getByRole("button", { name, exact: true });
const card = (page: Page, id: string) => page.getByTestId(`agency-stay-${staySlug(id)}`);
/** What the fake Google drew (`agencyMapFake`): maps made and area circles. */
const fakeMap = (page: Page) =>
  page.evaluate(() => (window as unknown as { __agencyMap: Record<string, number> }).__agencyMap);

async function open(
  page: Page,
  baseURL: string | undefined,
  options: { layout: { allowed: string[]; default: string }; filters?: Record<string, boolean> },
) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const google = await mockAgencyMap(page);
  await mockAgencyPage(page, { page: agencyPage(options) });
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await expect(page.getByTestId("agency-count")).toContainText("8 of 10 stays are available");
  return google;
}

test("List + map: a pill per stay with its price, hover on either side, a pill opens its card", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  const google = await open(page, baseURL, {
    layout: { allowed: all, default: "split" },
    filters: { propertyType: true },
  });

  await expect(layouts(page).getByRole("button")).toHaveText(["List", "List + map", "Map"]);
  await expect(layouts(page).getByRole("button", { name: "List + map" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The cards and, beside them, the map: Google only once the guest asks.
  await expect(card(page, "mertha")).toBeVisible();
  await expect(
    page.getByTestId("agency-map").getByRole("button", { name: "Show map" }),
  ).toBeVisible();
  expect(google).toHaveLength(0);
  await page.getByRole("button", { name: "Show map" }).click();
  await expect(map(page)).toBeVisible();
  await expect.poll(() => google.length).toBeGreaterThan(0);

  // One pill per stay shown, with its price per night; Adhidrawa shows no location.
  await expect(map(page).getByRole("button")).toHaveCount(7);
  const mertha = pill(page, "Mertha Carik Guest House, from US$38 per night");
  await expect(mertha).toHaveText("US$38");
  await expect(pill(page, "Adhidrawa Ubud, from US$45 per night")).toHaveCount(0);
  // The Tamarin Villas show their area only: a circle, and no pin on a spot.
  const tamarin = pill(page, "The Tamarin Villas, from US$128 per night");
  await expect(tamarin.locator("svg")).toHaveCount(0);
  await expect(mertha.locator("svg")).toHaveCount(1);
  expect(await fakeMap(page)).toMatchObject({ maps: 1, circles: 1 });

  // A card under the mouse lights its pill; a pill under the mouse lights its card.
  await card(page, "mertha").hover();
  await expect(mertha).toHaveClass(/bg-primary-600/);
  const escape = pill(page, "The Escape Villa Ubud, from US$95 per night");
  await escape.hover();
  await expect(card(page, "escape")).toHaveAttribute("data-highlighted", "true");
  await expect(mertha).not.toHaveClass(/bg-primary-600/);

  // A pill opens the stay's small card, with View rooms for the search.
  await escape.click();
  const chosen = page.getByTestId("agency-map-card");
  await expect(chosen).toContainText("The Escape Villa Ubud");
  await expect(chosen).toContainText("Villa · from US$95 / night");
  await expect(chosen.getByRole("link", { name: "View rooms" })).toHaveAttribute(
    "href",
    await card(page, "escape")
      .getAttribute("href")
      .then((href) => href!),
  );
  await chosen.getByRole("button", { name: "Close" }).click();
  await expect(chosen).toHaveCount(0);
  await escape.click();
  await expect(chosen).toBeVisible();

  // Pills follow the filters: two guest houses, one of them on the map.
  await page
    .getByRole("group", { name: "Property type" })
    .getByRole("button", { name: "Guest house" })
    .click();
  await expect(map(page).getByRole("button")).toHaveCount(1);
  await expect(chosen).toHaveCount(0);
  // Undone, every pill is back and the closed card stays closed. Filters and sorting never load
  // a new map: the guest's view stays.
  await page
    .getByRole("group", { name: "Property type" })
    .getByRole("button", { name: "All" })
    .click();
  await expect(map(page).getByRole("button")).toHaveCount(7);
  await expect(chosen).toHaveCount(0);
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("price_high");
  expect(await fakeMap(page)).toMatchObject({ maps: 1 });
  await assertHealthy();
});

test("Map: the agency's default, full width, and only the layouts it allows", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  // The guest chose to see maps earlier in this tab: the map loads at once.
  await page.addInitScript(() => sessionStorage.setItem("vayada.booking.showMap", "1"));
  await open(page, baseURL, { layout: { allowed: ["list", "map"], default: "map" } });

  await expect(layouts(page).getByRole("button")).toHaveText(["List", "Map"]);
  await expect(layouts(page).getByRole("button", { name: "Map" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(map(page).getByRole("button")).toHaveCount(7);
  await expect(page.getByTestId("agency-stays")).toHaveCount(0);
  const box = await page.getByTestId("agency-map").boundingBox();
  expect(box!.width).toBeGreaterThan(1200);

  await layouts(page).getByRole("button", { name: "List" }).click();
  await expect(page.getByTestId("agency-stays").getByRole("link")).toHaveCount(8);
  await expect(page.getByTestId("agency-map")).toHaveCount(0);
  await assertHealthy();
});

test("only List: no layout switch and no map", async ({ page, baseURL }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  const google = await open(page, baseURL, { layout: { allowed: ["list"], default: "list" } });
  await expect(page.getByTestId("agency-stays").getByRole("link")).toHaveCount(8);
  await expect(layouts(page)).toHaveCount(0);
  await expect(page.getByTestId("agency-map")).toHaveCount(0);
  expect(google).toHaveLength(0);
  await assertHealthy();
});

test("a phone keeps the list, whatever the agency's default", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await page.setViewportSize({ width: 390, height: 844 });
  const google = await mockAgencyMap(page);
  await mockAgencyPage(page, { page: agencyPage({ layout: { allowed: all, default: "split" } }) });
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await expect(page.getByTestId("agency-stays").getByRole("link")).toHaveCount(8);
  await expect(layouts(page)).toHaveCount(0);
  await expect(page.getByTestId("agency-map")).toHaveCount(0);
  expect(google).toHaveLength(0);
  await assertHealthy();
});
