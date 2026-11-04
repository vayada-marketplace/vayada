import { expect, test, type Page } from "@playwright/test";

import { mockAgencyMap } from "../support/agencyMapFake";
import {
  agencyPage,
  agencyUrl,
  mockAgencyPage,
  searchDates,
  staySlug,
} from "../support/agencyPageMocks";
import { mockStayHotel } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2461: below a stay's rooms on its agency page, "Other stays nearby" (up to 8, closest
// first, scrolling sideways) and a map with this stay as a dark pin and the others with their
// prices; a card and its pin light up together. Each part only when the agency switched it on.

const expectedMissingUrls = [
  /\/api\/booking-web\/hotels\/the-travel-ubud(\/checkout-config)?(\?.*)?$/,
];
const { checkIn, checkOut } = searchDates();
const search = `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`;
const escape = staySlug("escape");

const nearby = (page: Page) => page.getByTestId("agency-nearby-stays").getByRole("link");
const map = (page: Page) =>
  page.getByRole("region", { name: "Map of this stay and the stays nearby" });

async function open(
  page: Page,
  baseURL: string | undefined,
  stayPage?: { nearby: boolean; map: boolean },
  query = search,
) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const google = await mockAgencyMap(page);
  await mockAgencyPage(page, { page: agencyPage({ stayPage }) });
  await mockStayHotel(page, escape, "The Escape Villa Ubud");
  await mockStayHotel(page, staySlug("mertha"), "Mertha Carik Guest House");
  await page.goto(agencyUrl(baseURL, `/stays/${escape}${query}`));
  await expect(page.getByTestId("room-card-suite")).toBeVisible();
  return google;
}

test("lists up to 8 other stays, closest first, with distance and price, scrolling sideways", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL);

  await expect(page.getByRole("heading", { name: "Other stays nearby" })).toBeVisible();
  // Nine other stays: Adhidrawa has no map location, so it is the one left out.
  await expect(nearby(page)).toHaveCount(8);
  await expect(page.getByTestId(`agency-nearby-${staySlug("adhi")}`)).toHaveCount(0);
  const order = await nearby(page).evaluateAll((links) =>
    links.map((link) => link.getAttribute("data-testid")!.replace(/^agency-nearby-/, "")),
  );
  expect(order.slice(0, 3)).toEqual([staySlug("mertha"), staySlug("ranes"), staySlug("uma")]);

  const mertha = page.getByTestId(`agency-nearby-${staySlug("mertha")}`);
  await expect(mertha).toContainText("Mertha Carik Guest House");
  await expect(mertha).toContainText(/Guest house · \d+ m away/);
  await expect(mertha).toContainText("from US$38 / night");
  // A stay shown by its area only is "about" so far.
  await expect(page.getByTestId(`agency-nearby-${staySlug("tamarin")}`)).toContainText(
    "Villa · about 2 km away",
  );
  // Uma is full on these dates.
  await expect(page.getByTestId(`agency-nearby-${staySlug("uma")}`)).toContainText(
    "Not available for these dates",
  );
  const row = page.getByTestId("agency-nearby-stays");
  expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // A card opens that stay's page with the same search.
  await mertha.click();
  await expect(page).toHaveURL(new RegExp(`/stays/${staySlug("mertha")}\\?checkIn=${checkIn}`));
  await expect(page.getByTestId("agency-stay-box")).toContainText("Mertha Carik Guest House");
  await assertHealthy();
});

test("the stay's map: its own dark pin, the others' prices, and cards and pins light up together", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  const google = await open(page, baseURL);

  // "Map" in the stay's box goes to the map; Google waits for the guest.
  await page.getByTestId("agency-stay-box").getByRole("link", { name: "Map" }).click();
  await expect(page).toHaveURL(/#stay-map$/);
  const stayMap = page.getByTestId("agency-stay-map");
  await expect(stayMap.getByRole("button", { name: "Show map" })).toBeVisible();
  expect(google).toHaveLength(0);
  await stayMap.getByRole("button", { name: "Show map" }).click();
  await expect(map(page)).toBeVisible();
  await expect.poll(() => google.length).toBeGreaterThan(0);

  // This stay (dark, by name) and the 8 nearby stays with a pin.
  await expect(map(page).getByRole("button")).toHaveCount(9);
  const own = map(page).getByRole("button", { name: "The Escape Villa Ubud", exact: true });
  await expect(own).toHaveClass(/bg-primary-600/);
  const merthaPin = map(page).getByRole("button", {
    name: "Mertha Carik Guest House, from US$38 per night",
  });
  await expect(merthaPin).toHaveText("US$38");

  // A card under the mouse lights its pin, which then names the stay; and the other way round.
  await page.getByTestId(`agency-nearby-${staySlug("mertha")}`).hover();
  await expect(merthaPin).toHaveClass(/bg-primary-600/);
  await expect(merthaPin).toHaveText("Mertha Carik Guest House · US$38");
  const ranesPin = map(page).getByRole("button", { name: /^Rane's Villa, from/ });
  await ranesPin.hover();
  await expect(page.getByTestId(`agency-nearby-${staySlug("ranes")}`)).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  await assertHealthy();
});

test("keeps the agency's search: its room count and code go on to the nearby stays", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  // The agency searched 2 rooms with a code; this stay fits them in one and doesn't take it.
  await open(page, baseURL, undefined, `${search}&agencyRooms=2&agencyPromo=AUTUMN`);
  const href = await page.getByTestId(`agency-nearby-${staySlug("mertha")}`).getAttribute("href");
  const params = new URL(href!, "http://agency").searchParams;
  expect(params.get("adults")).toBe("2");
  expect(params.get("agencyRooms") ?? params.get("rooms")).toBe("2");
  expect(params.get("agencyPromo") ?? params.get("promoCode")).toBe("AUTUMN");
  // And back to all stays with it.
  await expect(
    page.getByTestId("agency-stay-box").getByRole("link", { name: "All stays" }),
  ).toHaveAttribute(
    "href",
    `/?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&rooms=2&promoCode=AUTUMN`,
  );
  await assertHealthy();
});

test("shows only the parts the agency switched on", async ({ page, baseURL }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL, { nearby: false, map: true });
  await expect(page.getByTestId("agency-nearby-stays")).toHaveCount(0);
  await expect(page.getByTestId("agency-stay-map")).toBeVisible();
  await assertHealthy();
});

test("shows neither without the agency's switches", async ({ page, baseURL }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL, { nearby: false, map: false });
  await expect(page.getByTestId("agency-nearby")).toHaveCount(0);
  await expect(page.getByTestId("agency-stay-box").getByRole("link", { name: "Map" })).toHaveCount(
    0,
  );
  await assertHealthy();
});
