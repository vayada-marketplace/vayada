import { expect, test, type Page } from "@playwright/test";

import { mockAgencyMap } from "../support/agencyMapFake";
import {
  agencyPage,
  agencyUrl,
  mockAgencyPage,
  searchDates,
  staySlug,
} from "../support/agencyPageMocks";
import { mockAnyPrice } from "../support/bookFlow";
import { mockStayHotel } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2463: a stay's page of an agency on a phone (Timo's mobile prototype, 390 wide): the
// agency's slim bar instead of the hero, the search card in place, "All stays" and a compact box
// with Gallery and Map, the same room cards, the nearby stays sideways over a small map, and a
// white bar along the bottom with the total and Continue. Nothing scrolls sideways.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const expectedMissingUrls = [
  /\/api\/booking-web\/hotels\/the-travel-ubud(\/checkout-config)?(\?.*)?$/,
];
const { checkIn, checkOut } = searchDates();
const search = `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`;
const escape = staySlug("escape");

async function open(
  page: Page,
  baseURL: string | undefined,
  data: ReturnType<typeof agencyPage> = agencyPage(),
) {
  await mockAgencyMap(page);
  await mockAgencyPage(page, { page: data });
  await mockStayHotel(page, escape, "The Escape Villa Ubud");
  await page.goto(agencyUrl(baseURL, `/stays/${escape}${search}`));
  await expect(page.getByTestId("room-card-suite")).toBeVisible();
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test("the slim bar, the search card in place, All stays and a compact box", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL);

  // No hero: the agency's slim bar, as on checkout, then the search card right under it.
  await expect(page.getByRole("heading", { name: "The Travel Ubud" })).toHaveCount(0);
  await expect(
    page.getByRole("navigation").first().getByRole("link", { name: "The Travel Ubud" }),
  ).toBeVisible();
  const card = await page.locator("#stay-search").boundingBox();
  expect(card!.y).toBeLessThan(140);

  // "All stays", then the box: the stay's name is the page's heading here.
  const back = page.getByRole("link", { name: "All stays" });
  await expect(back).toHaveAttribute("href", `/?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`);
  const box = page.getByTestId("agency-stay-box");
  expect((await back.boundingBox())!.y).toBeLessThan((await box.boundingBox())!.y);
  await expect(box.getByRole("heading", { level: 1, name: "The Escape Villa Ubud" })).toBeVisible();
  // Before the rooms and their heading, which comes after the page's h1.
  // VAY-2494: the phone's shorter heading.
  const rooms = page.getByRole("heading", { name: "Available stays" });
  expect((await box.boundingBox())!.y).toBeLessThan((await rooms.boundingBox())!.y);
  await expect(page.locator("h1, h2").first()).toHaveText("The Escape Villa Ubud");
  await expect(box).toContainText("Ubud · Private pool · 3 villas");
  const gallery = box.getByRole("button", { name: "Open photo gallery: The Escape Villa Ubud" });
  const map = box.getByRole("link", { name: "Map" });
  const [g, m] = [await gallery.boundingBox(), await map.boundingBox()];
  // Side by side, the same size, with room to tap.
  expect(Math.abs(g!.y - m!.y)).toBeLessThan(2);
  expect(Math.abs(g!.width - m!.width)).toBeLessThan(2);
  expect(g!.height).toBeGreaterThanOrEqual(44);
  expect(m!.x + m!.width).toBeLessThanOrEqual(390);

  // The same room cards; the search card scrolls away with the page.
  await page.getByTestId("select-rate-suite").scrollIntoViewIfNeeded();
  const scrolled = await page.locator("#stay-search").boundingBox();
  expect(scrolled!.y + scrolled!.height).toBeLessThan(0);
  await noSidewaysScroll(page);
  await assertHealthy();
});

test("Check Availability goes to the stay's box; one photo leaves Map the whole row", async ({
  page,
  baseURL,
}) => {
  const data = agencyPage();
  const escapeStay = data.stays.find((one) => one.slug === escape)!;
  escapeStay.photos = escapeStay.photos.slice(0, 1);
  await open(page, baseURL, data);
  const box = page.getByTestId("agency-stay-box");
  await expect(box.getByRole("button", { name: /photo gallery/ })).toHaveCount(0);
  const map = await box.getByRole("link", { name: "Map" }).boundingBox();
  const frame = await box.boundingBox();
  expect(map!.width).toBeGreaterThan(frame!.width - 40);

  await page.getByRole("button", { name: "Check Availability" }).click();
  await expect
    .poll(async () => (await page.getByRole("link", { name: "All stays" }).boundingBox())!.y)
    .toBeLessThan(60);
  expect(
    (await page.getByRole("link", { name: "All stays" }).boundingBox())!.y,
  ).toBeGreaterThanOrEqual(0);
});

test("a chosen rate shows a white bar along the bottom; Continue opens checkout here", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await mockAnyPrice(page);
  await open(page, baseURL);
  await page.getByTestId("select-rate-suite").click();

  const bar = page.getByTestId("agency-choice-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Suite · 2 nights");
  // One row, the screen's width, on its bottom edge.
  expect(await bar.boundingBox()).toMatchObject({ x: 0, width: 390 });
  const shown = await bar.boundingBox();
  expect(Math.round(shown!.y + shown!.height)).toBe(844);
  expect(shown!.height).toBeLessThan(110);
  const go = bar.getByRole("link", { name: "Continue" });
  expect(Math.abs((await go.boundingBox())!.y - shown!.y)).toBeLessThan(30);
  // The page's end stays clear of it.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const nearby = await page.getByTestId("agency-nearby").boundingBox();
  expect(nearby!.y + nearby!.height).toBeLessThanOrEqual(shown!.y + 1);
  await noSidewaysScroll(page);

  await go.click();
  await expect(page).toHaveURL(new RegExp(`/stays/${escape}/book\\?.*offer=`));
  await assertHealthy();
});

test("the nearby stays scroll sideways over a small map, with no hint to hover", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo, { expectedMissingUrls });
  await open(page, baseURL);
  const nearby = page.getByTestId("agency-nearby");
  await nearby.scrollIntoViewIfNeeded();
  await expect(nearby).toContainText("Scroll sideways for more.");
  await expect(nearby).not.toContainText("Hover");
  const row = page.getByTestId("agency-nearby-stays");
  const sizes = await row.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  expect((await row.locator("li").first().boundingBox())!.width).toBe(200);
  expect((await page.getByTestId("agency-stay-map").boundingBox())!.height).toBe(240);
  // The box's Map goes to it.
  await page.getByTestId("agency-stay-box").getByRole("link", { name: "Map" }).click();
  await expect(page).toHaveURL(/#stay-map$/);
  await noSidewaysScroll(page);
  await assertHealthy();
});

test("a wide screen keeps the hero, the sticky search card and the dark bar", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockAnyPrice(page);
  await open(page, baseURL);
  await expect(page.getByRole("heading", { level: 1, name: "The Travel Ubud" })).toBeVisible();
  await expect(page.getByTestId("agency-stay-box").getByRole("heading", { level: 2 })).toHaveText(
    "The Escape Villa Ubud",
  );
  await page.getByTestId("select-rate-suite").click();
  const bar = await page.getByTestId("agency-choice-bar").boundingBox();
  expect(bar!.x).toBeGreaterThan(0);
  expect(Math.round(bar!.y + bar!.height)).toBe(780);
  await page.evaluate(() => window.scrollTo(0, 1200));
  const card = await page.locator("#stay-search").boundingBox();
  expect(card!.y).toBeGreaterThanOrEqual(0);
  expect(card!.y).toBeLessThan(40);
});
