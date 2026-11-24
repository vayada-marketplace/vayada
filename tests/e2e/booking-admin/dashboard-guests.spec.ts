import { expect, test, type Page } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

/** As the mockup: 47 guests, 22 with a date of birth. */
async function mockGuests(
  page: Page,
  { agesHidden = false, noAges = false, averageNights = 3.4, averageLeadDays = 24.3 } = {},
) {
  const reads: URL[] = [];
  await page.route("**/api/booking/properties/*/dashboard/guests**", (route) => {
    reads.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        guestInsights: {
          guestCount: 47,
          nationalities: [
            { countryCode: "AU", guestCount: 11 },
            { countryCode: "DE", guestCount: 8 },
            { countryCode: "ID", guestCount: 7 },
            { countryCode: "GB", guestCount: 6 },
            { countryCode: "NL", guestCount: 5 },
            { countryCode: "FR", guestCount: 4 },
            { countryCode: null, guestCount: 6 },
          ],
          ages: [
            { bucket: "18-24", guestCount: noAges ? 0 : 2 },
            { bucket: "25-34", guestCount: noAges ? 0 : 9 },
            { bucket: "35-44", guestCount: noAges ? 0 : 6 },
            { bucket: "45-54", guestCount: noAges ? 0 : 3 },
            { bucket: "55+", guestCount: noAges ? 0 : 2 },
          ],
          ageKnownCount: noAges ? 0 : 22,
          stays: [
            { bucket: "1-2", guestCount: 12 },
            { bucket: "3-4", guestCount: 21 },
            { bucket: "5-7", guestCount: 10 },
            { bucket: "8+", guestCount: 4 },
          ],
          averageNights,
          averageLeadDays,
        },
        agesHidden,
      },
    });
  });
  return reads;
}

const card = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Guest insights" }) });

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("guest insights: four tiles and nationality, age and length of stay (VAY-2594)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reads = await mockGuests(page);
  await page.goto("/dashboard");
  const section = card(page);
  await expect(
    section.getByText("Who booked with you · all channels · Last 30 days"),
  ).toBeVisible();
  for (const [label, value] of [
    ["Guests", "47"],
    ["Top market", "Australia"],
    ["Avg. stay", "3.4 nights"],
    ["Avg. lead time", "24 days"],
  ])
    await expect(section.getByText(label, { exact: true }).locator("..")).toContainText(value);

  // Nationality: five countries, then the rest (France and not given) together.
  const rows = section.getByRole("listitem");
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText("Australia");
  await expect(rows.first()).toContainText("11 guests");
  await expect(rows.first()).toContainText("23%");
  // The country's flag, hidden from screen readers (the name says it).
  await expect(rows.first().locator('[aria-hidden="true"]')).toHaveText(
    String.fromCodePoint(0x1f1e6 + 0, 0x1f1e6 + 20),
  );
  await expect(rows.last().locator('[aria-hidden="true"]')).toHaveCount(0);
  await expect(rows.last()).toContainText("Other / not given");
  await expect(rows.last()).toContainText("10 guests");
  const shares = await section.getByText(/^\d+%$/).allTextContents();
  expect(shares.reduce((sum, share) => sum + Number(share.replace("%", "")), 0)).toBe(100);
  await section.screenshot({ path: testInfo.outputPath("guests-nationality-1440.png") });

  const tabs = section.getByRole("group", { name: "Guest insight" });
  await tabs.getByRole("button", { name: "Age" }).click();
  await expect(tabs.getByRole("button", { name: "Age" })).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(5);
  // Shares of the guests whose age is known: 9 of 22.
  await expect(rows.nth(1)).toContainText("25–34");
  await expect(rows.nth(1)).toContainText("41%");
  await expect(
    section.getByText(
      "Based on 22 of 47 guests with a date of birth from their profile or check-in.",
    ),
  ).toBeVisible();

  await tabs.getByRole("button", { name: "Length of stay" }).click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText("3–4 nights");
  await expect(rows.nth(1)).toContainText("45%");
  await expect(section.getByText(/^Based on/)).toHaveCount(0);

  // The range and its label follow the page.
  await page
    .getByRole("group", { name: "Date range" })
    .getByRole("button", { name: "7 days" })
    .click();
  await expect(section.getByText("Who booked with you · all channels · Last 7 days")).toBeVisible();
  const last = reads.at(-1)!.searchParams;
  expect(
    (Date.parse(`${last.get("periodEnd")}T00:00:00Z`) -
      Date.parse(`${last.get("periodStart")}T00:00:00Z`)) /
      86_400_000,
  ).toBe(6);
});

test("ages only for people who may read reservations; one night is singular", async ({ page }) => {
  await mockGuests(page, { agesHidden: true, averageNights: 1, averageLeadDays: 1 });
  await page.goto("/dashboard");
  const section = card(page);
  await expect(section.getByText("Avg. stay", { exact: true }).locator("..")).toContainText(
    /^Avg\. stay\s*1 night$/,
  );
  await expect(section.getByText("Avg. lead time", { exact: true }).locator("..")).toContainText(
    /1 day$/,
  );
  await section.getByRole("button", { name: "Age" }).click();
  await expect(
    section.getByText("Ages show only to people who can see reservations."),
  ).toBeVisible();
  await expect(section.getByRole("listitem")).toHaveCount(0);
  await expect(section.getByText(/^Based on/)).toHaveCount(0);
});

test("without any date of birth, the Age tab says so in one sentence (VAY-2594)", async ({
  page,
}) => {
  await mockGuests(page, { noAges: true });
  await page.goto("/dashboard");
  const section = card(page);
  await section.getByRole("button", { name: "Age" }).click();
  await expect(section.getByText("No guest has a date of birth yet.")).toHaveCount(1);
  await expect(section.getByText(/^Based on/)).toHaveCount(0);
  await expect(section.getByRole("listitem")).toHaveCount(0);
});

test("on a small phone the bars go under their rows, without scrolling sideways", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 1400 });
  await mockGuests(page);
  await page.goto("/dashboard");
  const section = card(page);
  const rows = section.getByRole("listitem");
  await expect(rows).toHaveCount(6);
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  // Each bar's track spans its row, under the label.
  const track = rows.first().locator("div.h-2");
  const [row, bar, label] = [
    (await rows.first().boundingBox())!,
    (await track.boundingBox())!,
    (await rows.first().getByText("Australia").boundingBox())!,
  ];
  expect(bar.width).toBeGreaterThan(row.width - 2);
  expect(bar.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
  await section.screenshot({ path: testInfo.outputPath("guests-360.png") });
});
