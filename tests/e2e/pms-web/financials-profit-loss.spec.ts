import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
} from "../support/pmsWebMocks";

const root = `/finance/properties/${PMS_WEB_PROPERTY_ID}/financials`;
const categoryId = "12140000-0000-4000-8000-0000000000aa";
const money = (amount: string) => ({ amount, currency: "EUR" });
const metric = (amount: string) => ({
  value: money(amount),
  absoluteChange: money("0.0000"),
  percentChange: null,
});
const envelope = {
  contractVersion: "pms-financials.v1",
  propertyId: PMS_WEB_PROPERTY_ID,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: "2026-09-17T12:00:00.000Z",
  sourceFreshness: {},
  incompleteEvidence: [],
};

test("shows reconciled monthly P&L and exports the selected year", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-owner-membership",
        roleKey: "hotel_owner",
        permissions: ["pms.finance.read"],
      },
    }),
  );
  await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/public-profile`, (route) =>
    route.fulfill({
      json: {
        propertyId: PMS_WEB_PROPERTY_ID,
        profileRevision: 1,
        publicProfile: {
          locale: "en-GB",
          shortDescription: null,
          longDescription: null,
          media: [],
        },
      },
    }),
  );
  await page.route(
    (url) => url.pathname === `${root}/dashboard`,
    (route) =>
      route.fulfill({
        json: {
          ...envelope,
          cards: {
            revenueToday: metric("0.0000"),
            revenueMtd: metric("100.0000"),
            expensesMtd: metric("20.0000"),
            profitMtd: metric("80.0000"),
          },
          daily: [],
          upcoming: [],
        },
      }),
  );
  await page.route(
    (url) => url.pathname === `${root}/expense-categories`,
    (route) =>
      route.fulfill({
        json: {
          ...envelope,
          item: [
            {
              id: categoryId,
              systemKey: null,
              name: "Laundry",
              color: "#1D4ED8",
              sortOrder: 1,
              archived: false,
              revision: 1,
            },
          ],
        },
      }),
  );
  await page.route(
    (url) => url.pathname === `${root}/profit-loss`,
    (route) => {
      const year = Number(new URL(route.request().url()).searchParams.get("year"));
      expect([2025, 2026]).toContain(year);
      const current = year === 2026;
      const months = Array.from({ length: current ? 9 : 12 }, (_, index) => ({
        month: `${year}-${String(index + 1).padStart(2, "0")}`,
        roomRevenue: money(current && index === 0 ? "100.0000" : "0.0000"),
        upsellRevenue: money("0.0000"),
        revenue: money(current && index === 0 ? "100.0000" : "0.0000"),
        expenses: money(current && index === 0 ? "20.0000" : "0.0000"),
        netProfit: money(current && index === 0 ? "80.0000" : "0.0000"),
        expenseCategories: {
          ota_commission: money("0.0000"),
          staff: money("0.0000"),
          utilities: money("0.0000"),
          maintenance_supplies: money("0.0000"),
          marketing_platform: money("0.0000"),
          [`custom:${categoryId}`]: money(current && index === 0 ? "20.0000" : "0.0000"),
        },
      }));
      return route.fulfill({
        json: {
          ...envelope,
          summary: {
            revenueYtd: metric(current ? "100.0000" : "0.0000"),
            expensesYtd: metric(current ? "20.0000" : "0.0000"),
            netProfitYtd: metric(current ? "80.0000" : "0.0000"),
          },
          months,
        },
      });
    },
  );

  await page.goto("/financials");
  await page.getByRole("tab", { name: "Profit & Loss" }).click();
  await expect(page.getByRole("heading", { name: "Profit & loss", exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /Laundry/ })).toContainText("€20.00");
  await expect(page.getByRole("row", { name: /Net profit/ })).toContainText("€80.00");
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);

  await page.getByRole("spinbutton", { name: "Year" }).fill("2025");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("table", { name: /Monthly profit and loss for 2025/ })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`pms-profit-loss-${PMS_WEB_PROPERTY_ID}-2025.csv`);
  const body = await readFile(await download.path(), "utf8");
  expect(body).toContain('"2025-01 (EUR)"');
  expect(body).not.toContain('"2026-01 (EUR)"');
  expect(body).toContain('"Laundry"');
});
