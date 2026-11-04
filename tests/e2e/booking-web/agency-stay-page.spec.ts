import { expect, test, type Page } from "@playwright/test";

import {
  agencyPage,
  agencyUrl,
  mockAgencyPage,
  searchDates,
  staySlug,
} from "../support/agencyPageMocks";
import { mockBookingApis, mockStayHotel } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2461: a stay's page on its agency's address: the agency's header and search, a box for the
// stay, its rooms as on its own page, and a dark bar with the choice that continues to the stay's
// own checkout (until checkout runs on the agency's address, VAY-2462).

const expectedMissingUrls = [
  /\/api\/booking-web\/hotels\/the-travel-ubud(\/checkout-config)?(\?.*)?$/,
];
const { checkIn, checkOut } = searchDates();
const search = `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`;
const escape = staySlug("escape");

async function open(page: Page) {
  await mockAgencyPage(page, { page: agencyPage() });
  await mockStayHotel(page, escape, "The Escape Villa Ubud");
}

test("a stay card opens the stay's page on the agency's address, with the same search", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page);
  await page.goto(agencyUrl(baseURL, `/${search}`));
  await page.getByTestId(`agency-stay-${escape}`).click();

  await expect(page).toHaveURL(
    new RegExp(
      `^http://the-travel-ubud\\.[^/]+/stays/${escape}\\?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0$`,
    ),
  );
  // The agency's header stays on top.
  await expect(page.getByRole("heading", { level: 1, name: "The Travel Ubud" })).toBeVisible();
  const box = page.getByTestId("agency-stay-box");
  await expect(box.getByRole("heading", { name: "The Escape Villa Ubud" })).toBeVisible();
  await expect(box).toContainText("Villa");
  await expect(box).toContainText("Ubud · Private pool · 3 villas");
  await expect(
    box.getByRole("button", { name: "Open photo gallery: The Escape Villa Ubud" }),
  ).toBeVisible();
  await expect(box.getByRole("link", { name: "All stays" })).toHaveAttribute(
    "href",
    `/?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`,
  );

  // The stay's rooms, as on its own page: one room, no room tabs.
  await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
  await expect(page.getByTestId("room-card-suite")).toBeVisible();
  await expect(page.getByTestId("room-tab-1")).toHaveCount(0);
  await assertHealthy();
});

test("a chosen rate shows the dark bar, whose Continue opens the stay's own checkout", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page);
  await page.goto(agencyUrl(baseURL, `/stays/${escape}${search}`));
  await expect(page.getByTestId("agency-choice-bar")).toHaveCount(0);
  await page.getByTestId("select-rate-suite").click();

  const bar = page.getByTestId("agency-choice-bar");
  await expect(bar).toContainText("The Escape Villa Ubud");
  await expect(bar).toContainText("Suite");
  // EUR 300.00, shown in the agency's display currency (US$1 = €0.90).
  await expect(bar).toContainText("≈ US$333");
  const href = await bar.getByRole("link", { name: "Continue" }).getAttribute("href");
  const url = new URL(href!);
  expect(url.host).toBe(
    new URL(agencyUrl(baseURL)).host.replace(/^the-travel-ubud\./, `${escape}.`),
  );
  expect(url.pathname).toBe("/book");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    checkIn,
    checkOut,
    adults: "2",
    offer: `pricing-offer.v2:${"a".repeat(64)}`,
  });
  // The page stays put until Continue.
  await expect(page).toHaveURL(new RegExp(`/stays/${escape}\\?`));
  await assertHealthy();
});

test("two rooms choose room by room, with the room tabs, and the bar names both", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page);
  await page.goto(
    agencyUrl(baseURL, `/stays/${escape}?checkIn=${checkIn}&checkOut=${checkOut}&adults=4&rooms=2`),
  );
  await expect(page.getByTestId("room-tab-1")).toBeVisible();
  await expect(page.getByTestId("room-tab-2")).toBeVisible();
  const suite = page.getByTestId("room-card-suite");
  await suite.getByRole("button", { name: "Select for Room 1" }).click();
  await suite.getByRole("button", { name: "Select for Room 2" }).click();

  // Both rooms chosen: the bar names them, and Continue takes both to the stay's checkout.
  const bar = page.getByRole("region", { name: "Your choice" });
  await expect(bar).toContainText("Room 1: Suite · Room 2: Suite");
  await expect(
    page.getByRole("status").filter({
      hasText: /^The Escape Villa Ubud, Room 1: Suite · Room 2: Suite$/,
    }),
  ).toHaveCount(1);
  const href = await bar.getByRole("link", { name: "Continue" }).getAttribute("href");
  const url = new URL(href!);
  expect(url.searchParams.get("rooms")).toBe("2");
  expect(url.searchParams.getAll("pick")).toHaveLength(2);
  // The bar keeps the page's end clear of it.
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--fixed-bottom-bar")),
    )
    .toMatch(/^\d+px$/);

  // A room taken out makes the choice stale: the bar goes until the rooms are chosen again.
  await page.getByRole("button", { name: "Remove Room 2 from booking" }).click();
  await expect(bar).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--fixed-bottom-bar")),
    )
    .toBe("");
  await assertHealthy();
});

test("a stay the agency doesn't show is not online", async ({ page, baseURL }) => {
  await open(page);
  await page.goto(agencyUrl(baseURL, `/stays/${staySlug("someone-else")}${search}`));
  await expect(
    page.getByRole("heading", { name: "This booking page isn't online right now" }),
  ).toBeVisible();
  await expect(page.getByTestId("room-card-suite")).toHaveCount(0);
});

test("a hotel's address has no stay pages", async ({ page }) => {
  await mockBookingApis(page);
  await page.goto(`/stays/${escape}${search}`);
  await expect(
    page.getByRole("heading", { name: "This booking page isn't online right now" }),
  ).toBeVisible();
});
