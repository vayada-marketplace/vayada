import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

test("shows six steps with each one's share of the step before, the overall rate, CSV export and every range (VAY-2594)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const windows: string[] = [];
  let empty = false;
  let noBookings = false;
  const counts: [string, number][] = [
    ["page_visit", 1912],
    ["dates_searched", 846],
    ["rate_selected", 241],
    ["addons_step_passed", 200],
    ["details_completed", 92],
    ["complete_booking_clicked", 26],
    ["payment_authorized", 20],
    ["booking_completed", 18],
  ];
  await page.route("**/dashboard/conversion-funnel?**", (route) => {
    windows.push(route.request().url());
    return route.fulfill({
      json: {
        funnel: {
          steps: counts.map(([stage, count], index) => ({
            stage,
            count: empty || (noBookings && stage === "booking_completed") ? 0 : count,
            previousCount: empty ? 0 : counts[Math.max(0, index - 1)]![1],
            percentOfVisits: Math.round((count / 1912) * 1000) / 10,
            conversionPercent: null,
          })),
          paymentMethods: [{ method: "card", count: 20 }],
          biggestDrop: "rate_selected",
        },
      },
    });
  });
  await page.goto("/dashboard");
  const card = page
    .getByRole("heading", { name: "Conversion funnel", exact: true })
    .locator("xpath=../../..");
  await expect(card.getByText("From visitor to booked guest")).toBeVisible();
  const rows = card.getByRole("listitem");
  await expect(rows).toHaveCount(6);
  const lines = await rows.allInnerTexts();
  expect(lines.map((line) => line.replace(/\s+/g, " ").trim())).toEqual([
    "Visitors 1,912",
    "Searched dates 846 44%",
    "Selected room & rate 241 28%",
    "Completed guest details 92 38%",
    "Started payment 26 28%",
    "Confirmed booking 18 69%",
  ]);
  // Bars are as wide as their share of the visitors, at least a sliver.
  const bars = rows.locator("div.bg-\\[\\#2B4BF2\\]");
  expect(await bars.first().evaluate((el) => el.style.width)).toBe("100%");
  expect(await bars.last().evaluate((el) => el.style.width)).toBe("3%");
  await expect(card.getByText("Visitors who made a confirmed booking")).toBeVisible();
  await expect(card.getByText("0.94% overall")).toBeVisible();
  // No comments, tags or the card-payment branch.
  await expect(card.getByText(/Biggest drop|Authorized payment|add-ons|Card:/)).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath("conversion-funnel.png"), fullPage: true });
  await card.getByRole("button", { name: "About the conversion funnel" }).hover();
  await expect(card.getByRole("tooltip")).toContainText("Visitors who allowed analytics");
  await page.mouse.move(0, 0);

  // The export keeps every stage.
  await card.getByRole("button", { name: "Funnel options" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^conversion-funnel-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain('"Step","Visitors","% of visits"');
  expect(csv).toContain('"Searched dates","846"');
  expect(csv).toContain('"Authorized payment (card only)","20"');
  await expect(card.getByRole("button", { name: "Export CSV" })).toHaveCount(0);

  // On a phone the labels go above their bars, without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 1400 });
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({
    path: testInfo.outputPath("conversion-funnel-mobile.png"),
    animations: "disabled",
  });
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const [label, bar] = [
    await rows.first().getByText("Visitors").boundingBox(),
    await bars.first().boundingBox(),
  ];
  expect(label!.y + label!.height).toBeLessThanOrEqual(bar!.y + 1);
  await page.setViewportSize({ width: 1280, height: 1200 });

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThanOrEqual(2);
  await expect(card.getByText("0.94% overall")).toBeVisible();
  // Nobody booked: the last step has no blue bar, only a grey 0.
  noBookings = true;
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThanOrEqual(3);
  await expect(rows.last().getByText("0", { exact: true })).toHaveClass(/text-gray-400/);
  await expect(rows.last().locator("div.bg-\\[\\#2B4BF2\\]")).toHaveCount(0);
  noBookings = false;
  await page.getByRole("button", { name: "30 days", exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThanOrEqual(4);
  empty = true;
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(card.getByText("No booking data for this period")).toBeVisible();
  expect(new Set(windows.map((url) => new URL(url).searchParams.get("windowStart"))).size).toBe(3);
});

test("the funnel options and the page tabs share one time range", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const windowStarts: string[] = [];
  await page.route("**/dashboard/conversion-funnel?**", (route) => {
    windowStarts.push(new URL(route.request().url()).searchParams.get("windowStart") ?? "");
    return route.fulfill({
      json: {
        funnel: {
          steps: [
            { stage: "page_visit", count: 82, previousCount: 82, percentOfVisits: 100 },
            { stage: "rate_selected", count: 41, previousCount: 82, percentOfVisits: 50 },
          ].map((step) => ({ ...step, conversionPercent: null })),
          paymentMethods: [],
          biggestDrop: null,
        },
      },
    });
  });
  await page.goto("/dashboard");
  const card = page
    .getByRole("heading", { name: "Conversion funnel", exact: true })
    .locator("xpath=../../..");
  const options = card.getByRole("button", { name: "Funnel options" });
  // The page tabs come before the card; with the popover closed each label is unique.
  const tab = (name: string) => page.getByRole("button", { name, exact: true });
  const distinctWindows = () => new Set(windowStarts).size;
  await expect.poll(distinctWindows).toBe(1);

  // The page opens on the last 30 days (VAY-2594), and the funnel's options say so.
  await options.click();
  await expect(card.getByRole("button", { name: "30 days", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await card.screenshot({
    path: testInfo.outputPath("conversion-funnel-options.png"),
    animations: "disabled",
  });
  await card.getByRole("button", { name: "Today", exact: true }).click();
  await expect(card.getByRole("button", { name: "Export CSV" })).toHaveCount(0);
  await expect(tab("Today")).toHaveAttribute("aria-pressed", "true");
  await expect(tab("30 days")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(distinctWindows).toBe(2);

  await tab("7 days").click();
  await expect.poll(distinctWindows).toBe(3);
  await options.click();
  await expect(card.getByRole("button", { name: "7 days", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(card.getByRole("button", { name: "30 days", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
