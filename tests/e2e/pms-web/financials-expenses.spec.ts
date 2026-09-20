import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
} from "../support/pmsWebMocks";

const root = `/finance/properties/${PMS_WEB_PROPERTY_ID}/financials`;
const money = (amount: string) => ({ amount, currency: "EUR" });
const metric = (amount: string) => ({
  value: money(amount),
  absoluteChange: money("0.00"),
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
const category = {
  id: "12140000-0000-4000-8000-000000000001",
  systemKey: null,
  name: "Housekeeping",
  color: "#1D4ED8",
  sortOrder: 1,
  archived: false,
  revision: 1,
};

test("filters expenses and exports the same selection accessibly", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-owner-membership",
        roleKey: "hotel_owner",
        permissions: ["pms.finance.read", "pms.finance.manage"],
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
            revenueToday: metric("100.00"),
            revenueMtd: metric("100.00"),
            expensesMtd: metric("25.00"),
            profitMtd: metric("75.00"),
          },
          daily: [],
          upcoming: [],
        },
      }),
  );
  await page.route(
    (url) => url.pathname === `${root}/expense-categories`,
    (route) => route.fulfill({ json: { ...envelope, item: [category] } }),
  );
  await page.route(
    (url) => url.pathname === `${root}/expenses`,
    (route) => {
      const unpaid = new URL(route.request().url()).searchParams.get("paymentStatus") === "unpaid";
      return route.fulfill({
        json: {
          ...envelope,
          summary: {
            totalMtd: metric("125.00"),
            perOccupiedNight: metric("12.50"),
            unpaidAmount: metric("25.00"),
            unpaidCount: { value: 1, absoluteChange: 0, percentChange: null },
          },
          categories: [{ category, amount: money("125.00") }],
          page: {
            items: [
              {
                id: "12140000-0000-4000-8000-000000000003",
                categoryId: category.id,
                origin: "recurring",
                incurredOn: "2026-09-15",
                vendor: "Weekly laundry",
                amount: money("25.00"),
                paymentStatus: "unpaid",
                paidOn: null,
                recurringRuleId: "12140000-0000-4000-8000-000000000004",
                sourceKey: null,
                reversesExpenseId: null,
                revision: 1,
              },
              ...(!unpaid
                ? [
                    {
                      id: "12140000-0000-4000-8000-000000000005",
                      categoryId: category.id,
                      origin: "ota_commission",
                      incurredOn: "2026-09-14",
                      vendor: "Booking.com",
                      amount: money("100.00"),
                      paymentStatus: "paid",
                      paidOn: "2026-09-14",
                      recurringRuleId: null,
                      sourceKey: "booking-1",
                      reversesExpenseId: null,
                      revision: 1,
                    },
                  ]
                : []),
            ],
            nextCursor: null,
            limit: 50,
          },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `${root}/exports`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body.tab).toBe("expenses");
      expect(body.filters.paymentStatus).toBe("unpaid");
      expect(body.filters.from).toBe("2026-09-01");
      return route.fulfill({
        status: 202,
        json: {
          ...envelope,
          item: { resourceId: "export-1", state: "pending" },
          outcome: "created",
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `${root}/exports/export-1`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-financials-export.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: {
            resourceId: "export-1",
            state: "ready",
            expiresAt: "2026-09-18T12:00:00.000Z",
            download: {
              method: "GET",
              url: "https://files.example/expenses.csv",
              expiresAt: "2026-09-17T12:15:00.000Z",
            },
          },
        },
      }),
  );

  await page.goto("/financials");
  await page.getByRole("tab", { name: "Expenses" }).click();
  await expect(page.getByRole("heading", { name: "Expense ledger" })).toBeVisible();
  await expect(page.getByText("Booking.com")).toBeVisible();
  await page.getByLabel("Paid state").selectOption("unpaid");
  await expect(page.getByText("Weekly laundry")).toBeVisible();
  await expect(page.getByText("Booking.com")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
    "href",
    "https://files.example/expenses.csv",
  );
});
