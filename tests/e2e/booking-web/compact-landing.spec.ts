import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { mockAnyPrice } from "../support/bookFlow";
import { watchPageHealth } from "../support/pageHealth";
import { key, mockGroup } from "../support/roomPickerMocks";

// VAY-2448: a taller hero, then straight to the rooms: no stepper while choosing, and the sort on
// the heading's row. From the next step on, a slim bar replaces the hero and the stepper's Rooms
// goes back to the rooms.
const HOTEL = "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=2";
const BOOK = `/book?checkIn=2026-11-10&checkOut=2026-11-12&adults=2&offer=${key("a")}`;

async function open(page: Page, path: string) {
  await mockBookingApis(page);
  await mockGroup(page, []);
  await mockAnyPrice(page);
  await page.goto(path);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: "Reject analytics" }).click();
}

const heroHeight = (page: Page) =>
  page.evaluate(
    () =>
      document.getElementById("stay-search")!.previousElementSibling!.getBoundingClientRect()
        .height,
  );

test("keeps the rooms close to the search on a laptop", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, HOTEL);
  const cards = page.locator('[data-testid^="room-card-"]');
  await expect(cards.first()).toBeVisible();

  // About 55% of the window, between 400 and 640px.
  expect(await heroHeight(page)).toBe(495);
  for (const [width, height, expected] of [
    [1920, 1200, 640],
    [1366, 650, 400],
  ]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => heroHeight(page)).toBe(expected);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // No stepper and no "Prefer separate rooms?" line while choosing.
  await expect(page.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(page.getByText("Review & pay")).toHaveCount(0);
  await expect(page.getByText(/Prefer separate rooms\?/)).toHaveCount(0);

  // "Available Accommodations" and the sort on one row, 64px below the search, 36px above the
  // first card; 28px between cards.
  const sort = page.getByRole("combobox", { name: "Sort by" });
  const [search, title, select, first, second] = await Promise.all([
    page.locator("#stay-search").boundingBox(),
    page.getByRole("heading", { name: "Available Accommodations" }).boundingBox(),
    sort.boundingBox(),
    cards.nth(0).boundingBox(),
    cards.nth(1).boundingBox(),
  ]);
  expect(Math.abs(select!.y + select!.height / 2 - (title!.y + title!.height / 2))).toBeLessThan(3);
  expect(select!.x).toBeGreaterThan(title!.x + title!.width);
  expect(Math.round(select!.y - (search!.y + search!.height))).toBe(64);
  expect(Math.round(first!.y - (select!.y + select!.height))).toBe(36);
  expect(Math.round(second!.y - (first!.y + first!.height))).toBe(28);
  await expect(page.getByText("Sort by", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("compact-landing-1440.png") });

  // Sorting works as before.
  await sort.selectOption("priceHigh");
  await expect(cards.first()).toHaveAttribute("data-testid", "room-card-deluxe");
  await sort.selectOption("priceLow");
  await expect(cards.first()).toHaveAttribute("data-testid", "room-card-garden");
  await assertHealthy();
});

test("keeps the sort on the title's line when the approximate-amounts note shows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingApis(page, { displayDefaultCurrency: "USD" });
  await mockGroup(page, []);
  await page.goto(HOTEL);
  const note = page.getByTestId("approximate-amounts-note");
  await expect(note).toBeVisible();
  const [title, select, below] = await Promise.all([
    page.getByRole("heading", { name: "Available Accommodations" }).boundingBox(),
    page.getByRole("combobox", { name: "Sort by" }).boundingBox(),
    note.boundingBox(),
  ]);
  expect(Math.abs(select!.y + select!.height / 2 - (title!.y + title!.height / 2))).toBeLessThan(3);
  expect(below!.y).toBeGreaterThanOrEqual(select!.y + select!.height);
});

test("wraps the sort below the heading on a phone, with a 44px select", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, HOTEL);
  await expect(page.locator('[data-testid^="room-card-"]').first()).toBeVisible();
  const [title, select] = await Promise.all([
    page.getByRole("heading", { name: "Available Accommodations" }).boundingBox(),
    page.getByRole("combobox", { name: "Sort by" }).boundingBox(),
  ]);
  expect(select!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  expect(select!.height).toBeGreaterThanOrEqual(44);
  await assertHealthy();
});

for (const width of [1440, 390]) {
  test(`shows a slim bar and the stepper on /book, and Rooms goes back at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await open(page, BOOK);
    await expect(page).toHaveURL(/[?&]step=(extras|details)/);

    // The slim bar: the hotel's name in a 64px bar at the top, and the step's title right below
    // it instead of under a hero photo.
    const nav = page.locator("nav").first();
    await expect(nav.getByRole("link", { name: "Hotel Alpenrose" })).toBeVisible();
    const bar = (await nav.boundingBox())!;
    expect(bar.y).toBe(0);
    expect(bar.height).toBeLessThanOrEqual(65);
    const title = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    expect(title.y).toBeLessThan(200);

    // The stepper sits on the title's row; Rooms is done and goes back to the rooms.
    await expect(page.locator('[aria-current="step"]')).toHaveCount(1);
    const rooms = page.getByRole("button", { name: "Rooms", exact: true });
    await expect(rooms.locator("svg")).toHaveCount(1);
    const box = (await rooms.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    // Desktop: on the title's row.
    if (width === 1440) {
      expect(box.y).toBeLessThan(title.y + title.height);
      expect(box.y + box.height).toBeGreaterThan(title.y);
    }
    await page.screenshot({ path: testInfo.outputPath(`book-slim-bar-${width}.png`) });
    await rooms.click();
    await expect(page).toHaveURL(/\/\?checkIn=2026-11-10&checkOut=2026-11-12&adults=2$/);
    await expect(page.locator('[data-testid^="room-card-"]').first()).toBeVisible();
    await assertHealthy();
  });
}
