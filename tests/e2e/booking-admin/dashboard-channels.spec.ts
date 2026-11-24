import { expect, test, type Page } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const count = (key: string, bookingCount: number, previousBookingCount: number) => ({
  key,
  bookingCount,
  previousBookingCount,
});

/** As the mockup: 47 bookings now (18 direct), 43 before. */
async function mockChannels(page: Page) {
  const reads: URL[] = [];
  await page.route("**/api/booking/properties/*/dashboard/channels**", (route) => {
    reads.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        channelMix: {
          channels: [
            count("booking_com", 16, 18),
            count("direct", 18, 13),
            count("airbnb", 8, 9),
            count("agoda", 5, 0),
            count("other_ota", 0, 3),
          ],
          directSources: [
            count("social_media", 6, 4),
            count("whatsapp", 5, 4),
            count("booking_engine", 4, 4),
            count("call", 2, 1),
            count("walk_in", 1, 0),
          ],
        },
      },
    });
  });
  return reads;
}

const card = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Bookings by channel" }) });

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("all channels as bars: brand colors, shares and each share's change (VAY-2594)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reads = await mockChannels(page);
  await page.goto("/dashboard");
  const section = card(page);
  await expect(section.getByText("Direct vs OTAs · change vs previous period")).toBeVisible();
  const rows = section.getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Direct");
  await expect(rows.nth(0)).toContainText("18 bookings");
  await expect(rows.nth(0)).toContainText("38%");
  await expect(rows.nth(0).getByText("↑ 27%")).toHaveClass(/text-\[#0F7A3D\]/);
  await expect(rows.nth(1)).toContainText("Booking.com");
  await expect(rows.nth(1).getByText("↓ 19%")).toHaveClass(/text-\[#B42318\]/);
  await expect(rows.nth(3)).toContainText("Agoda");
  await expect(rows.nth(3)).toContainText("new");
  // "(vayada)" is gone, and a channel without bookings now isn't listed.
  await expect(section.getByText(/vayada|Other booking sites/)).toHaveCount(0);
  // Shares add up to 100.
  const shares = await section.getByText(/^\d+%$/).allTextContents();
  expect(shares.reduce((sum, share) => sum + Number(share.replace("%", "")), 0)).toBe(100);
  // Bars in the channels' colors, as wide as their share of the largest.
  const fill = (index: number) => rows.nth(index).locator("div.h-full");
  await expect(fill(0)).toHaveCSS("background-color", "rgb(43, 75, 242)");
  await expect(fill(1)).toHaveCSS("background-color", "rgb(0, 53, 128)");
  await expect(fill(2)).toHaveCSS("background-color", "rgb(255, 90, 95)");
  expect(await fill(0).evaluate((el) => el.style.width)).toBe("100%");
  // The range and the period right before it.
  const query = reads.at(-1)!.searchParams;
  expect(query.get("previousPeriodEnd")).not.toBeNull();
  expect(query.get("periodStart")).not.toBe(query.get("previousPeriodStart"));
  await section.screenshot({ path: testInfo.outputPath("channels-bars-1440.png") });
});

test("the toggles keep their place, direct sources and the donut's legend line up", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockChannels(page);
  await page.goto("/dashboard");
  const section = card(page);
  const scope = section.getByRole("group", { name: "Channel scope" });
  await expect(section.getByRole("listitem")).toHaveCount(4);
  const before = await scope.boundingBox();

  await scope.getByRole("button", { name: "Direct only" }).click();
  await expect(scope.getByRole("button", { name: "Direct only" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    section.getByText("Where your direct guests came from · change vs previous period"),
  ).toBeVisible();
  await expect(section.getByRole("listitem").first()).toContainText("Instagram / social");
  await expect(section.getByText("Booking page")).toBeVisible();
  await expect(section.getByText("Walk-in")).toBeVisible();
  expect(await scope.boundingBox()).toEqual(before);

  await section.getByRole("button", { name: "Show as donut" }).click();
  await expect(section.getByRole("button", { name: "Show as donut" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await scope.boundingBox()).toEqual(before);
  // Fixed legend columns: counts, shares and changes never spill, also with longer names.
  const legend = section.getByRole("listitem");
  const legendFits = async () => {
    const card = (await section.boundingBox())!;
    const cells = await legend.evaluateAll((items) =>
      items.flatMap((item) =>
        [2, 3, 4].map((index) => {
          const cell = item.children[index] as HTMLElement;
          return {
            spill: cell.scrollWidth - cell.clientWidth,
            right: cell.getBoundingClientRect().right,
          };
        }),
      ),
    );
    for (const cell of cells) {
      expect(cell.spill).toBeLessThanOrEqual(0);
      expect(cell.right).toBeLessThanOrEqual(card.x + card.width);
    }
  };
  await expect(legend.first()).toContainText("Instagram / social");
  await legendFits();
  await scope.getByRole("button", { name: "All channels" }).click();
  const donut = section.getByRole("img", {
    name: /^Bookings by channel: Direct 38%, Booking\.com 34%/,
  });
  await expect(donut).toBeVisible();
  await expect(donut).toContainText("47");
  await expect(donut).toContainText("bookings");
  // The columns line up row under row.
  const columnX = async (column: number) =>
    legend.evaluateAll(
      (items, index) =>
        items.map((item) => Math.round(item.children[index].getBoundingClientRect().right)),
      column,
    );
  for (const column of [2, 3, 4]) expect(new Set(await columnX(column)).size).toBe(1);
  await legendFits();
  await section.screenshot({ path: testInfo.outputPath("channels-donut-1440.png") });
});

test("on a small phone the card fits without scrolling sideways", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 1400 });
  await mockChannels(page);
  await page.goto("/dashboard");
  const section = card(page);
  await expect(section.getByRole("listitem")).toHaveCount(4);
  await section.getByRole("button", { name: "Show as donut" }).click();
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  // The toggles wrap rather than stick out.
  const toggles = await section
    .getByRole("group")
    .evaluateAll((groups) => groups.map((group) => group.getBoundingClientRect().right));
  const box = (await section.boundingBox())!;
  for (const right of toggles) expect(right).toBeLessThanOrEqual(box.x + box.width);
  await section.screenshot({ path: testInfo.outputPath("channels-donut-360.png") });
});
