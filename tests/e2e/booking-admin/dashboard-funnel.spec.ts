import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

test("shows inline drop-offs, the card branch, CSV export and recomputes all time tabs", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const windows: string[] = [];
  let empty = false;
  await page.route("**/dashboard/conversion-funnel?**", (route) => {
    windows.push(route.request().url());
    return route.fulfill({
      json: {
        funnel: {
          // 40 card clicks reach authorization; completion reunites 10 authorized + 40 non-card.
          steps: [
            ["page_visit", 100, 100, 100],
            ["rate_selected", 80, 100, 80],
            ["details_completed", 80, 80, 80],
            ["complete_booking_clicked", 80, 80, 80],
            ["payment_authorized", 10, 40, 10],
            ["booking_completed", 50, 50, 50],
          ].map(([stage, count, previousCount, percentOfVisits]) => ({
            stage,
            count: empty ? 0 : count,
            previousCount: empty ? 0 : previousCount,
            percentOfVisits,
            conversionPercent: null,
          })),
          paymentMethods: [
            { method: "card", count: 40 },
            { method: "bank_transfer", count: 40 },
          ],
          biggestDrop: "payment_authorized",
        },
      },
    });
  });
  await page.goto("/dashboard");
  const card = page
    .getByRole("heading", { name: "Conversion funnel", exact: true })
    .locator("xpath=../../..");
  await expect(card.getByText("Visitors to booked guests")).toBeVisible();
  await expect(card.getByText("Page visits · 100")).toBeVisible();
  await expect(card.getByText("−20 (20%)")).toBeVisible();
  await expect(card.getByText("Authorized payment (card only) · 10")).toBeVisible();
  await expect(card.getByText("−30 (75%)")).toBeVisible();
  await expect(card.getByText(/^0 \(0%\)/)).toHaveCount(3);
  await expect(card.getByText("Card: 40 (50%)")).toBeVisible();
  await expect(card.getByText("Biggest drop")).toHaveCount(0);
  await expect(card.getByText("Viewed a room")).toHaveCount(0);
  await expect(card.getByText("Added add-ons / skipped")).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath("conversion-funnel.png"), fullPage: true });
  await card.getByRole("button", { name: "About the conversion funnel" }).hover();
  await expect(card.getByRole("tooltip")).toBeVisible();
  await card.screenshot({
    path: testInfo.outputPath("conversion-funnel-tooltip.png"),
    animations: "disabled",
  });
  await page.mouse.move(0, 0);

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
  expect(csv).toContain('"Authorized payment (card only)","10","10","30","75"');
  await expect(card.getByRole("button", { name: "Export CSV" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 1400 });
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "About the conversion funnel" }).focus();
  await card.screenshot({
    path: testInfo.outputPath("conversion-funnel-mobile.png"),
    animations: "disabled",
  });
  // Page content scrolls inside <main>, so check it rather than the document.
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Tab");
  await page.setViewportSize({ width: 1280, height: 1200 });

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(card.getByText("Authorized payment (card only) · 10")).toBeVisible();
  await page.getByRole("button", { name: "This week", exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Last 30 days", exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThanOrEqual(3);
  empty = true;
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(card.getByText("No booking data for this period")).toBeVisible();
  expect(new Set(windows.map((url) => new URL(url).searchParams.get("windowStart"))).size).toBe(3);
});
