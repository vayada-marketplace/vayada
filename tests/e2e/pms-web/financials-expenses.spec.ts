import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
} from "../support/pmsWebMocks";

const root = `/api/finance/properties/${PMS_WEB_PROPERTY_ID}/financials`;
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
  const categories = [category];
  let createdExpense: Record<string, unknown> | null = null;
  let firstManualCommandId = "";
  let failNextCategoryUpdate = false;
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
    (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        expect(body.name).toBe("Utilities");
        const created = {
          ...category,
          id: "12140000-0000-4000-8000-000000000006",
          name: body.name,
          color: body.color,
          sortOrder: body.sortOrder,
        };
        categories.push(created);
        return route.fulfill({
          status: 201,
          json: { ...envelope, item: created, outcome: "created" },
        });
      }
      return route.fulfill({ json: { ...envelope, item: categories } });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith(`${root}/expense-categories/`),
    (route) => {
      const body = route.request().postDataJSON();
      const index = categories.findIndex(
        (item) => item.id === route.request().url().split("/").at(-1),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(body.expectedRevision).toBe(categories[index]?.revision);
      if (route.request().method() === "PATCH" && failNextCategoryUpdate) {
        failNextCategoryUpdate = false;
        categories[index] = { ...categories[index]!, revision: categories[index]!.revision + 1 };
        return route.fulfill({ status: 409, json: { code: "revision_conflict" } });
      }
      const updated = {
        ...categories[index]!,
        ...(route.request().method() === "PATCH"
          ? { name: body.name, color: body.color, sortOrder: body.sortOrder }
          : { archived: true }),
        revision: categories[index]!.revision + 1,
      };
      categories[index] = updated;
      return route.fulfill({ json: { ...envelope, item: updated, outcome: "updated" } });
    },
  );
  await page.route(
    (url) => url.pathname === `${root}/expenses`,
    (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        if (body.recurrence) {
          expect(body.vendor).toBe("Weekly cleaning");
          expect(body.recurrence).toEqual({ cadence: "weekly", startsOn: "2026-09-17" });
          expect(body.paymentStatus).toBe("paid");
          expect(body.paidOn).toBe("2026-09-17");
          return route.fulfill({
            status: 201,
            json: {
              ...envelope,
              item: { id: "12140000-0000-4000-8000-000000000008" },
              outcome: "created",
            },
          });
        }
        expect(body.vendor).toBe("Electric Co");
        expect(body.amount).toEqual(money("50.0000"));
        expect(body.paymentStatus).toBe("paid");
        expect(body.paidOn).toBe("2026-09-17");
        expect(body.notes).toBe("September utility bill");
        expect(body.receiptMediaId).toBeUndefined();
        expect(body.categoryId).toBe(categories[1]?.id);
        if (!firstManualCommandId) {
          firstManualCommandId = body.commandId;
          return route.abort("failed");
        }
        expect(body.commandId).toBe(firstManualCommandId);
        createdExpense = {
          id: "12140000-0000-4000-8000-000000000007",
          categoryId: body.categoryId,
          origin: "manual",
          incurredOn: body.incurredOn,
          vendor: body.vendor,
          amount: body.amount,
          paymentStatus: "paid",
          paidOn: body.paidOn,
          recurringRuleId: null,
          sourceKey: null,
          reversesExpenseId: null,
          revision: 1,
        };
        return route.fulfill({
          status: 201,
          json: { ...envelope, item: createdExpense, outcome: "created" },
        });
      }
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
              ...(createdExpense ? [createdExpense] : []),
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
      expect(body.filters.categoryId).toBe(category.id);
      expect(body.filters.from).toBe("2026-09-10");
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
  const insightTabs = page.getByRole("tablist", { name: "Financial insights" });
  for (const name of ["Dashboard", "Revenue", "Expenses"]) {
    const id = name.toLowerCase();
    await expect(insightTabs.getByRole("tab", { name })).toHaveAttribute(
      "aria-controls",
      `financial-insights-${id}-panel`,
    );
    await expect(page.locator(`#financial-insights-${id}-panel`)).toHaveAttribute(
      "aria-labelledby",
      `financial-insights-${id}-tab`,
    );
  }
  await page.getByRole("tab", { name: "Expenses" }).click();
  await expect(page.getByRole("heading", { name: "Expense ledger" })).toBeVisible();
  await expect(page.getByText("Booking.com")).toBeVisible();
  await page.getByLabel("From").fill("2026-09-10");
  await page.getByLabel("Paid state").selectOption("unpaid");
  await page.getByRole("combobox", { name: "Category" }).selectOption(category.id);
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Weekly laundry")).toBeVisible();
  await expect(page.getByText("Booking.com")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
    "href",
    "https://files.example/expenses.csv",
  );
  await page.getByLabel("Paid state").selectOption("");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Booking.com")).toBeVisible();
  await page.getByRole("button", { name: "Categories" }).click();
  const categoriesDialog = page.getByRole("dialog", { name: "Manage expense categories" });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual(
    [],
  );
  await categoriesDialog.getByLabel("Name").fill("Utilities");
  await categoriesDialog.getByRole("button", { name: "Create category" }).click();
  await expect(categoriesDialog).toHaveCount(0);
  await page.getByRole("button", { name: "Log expense" }).click();
  const expenseDialog = page.getByRole("dialog", { name: "Log expense" });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual(
    [],
  );
  await expenseDialog.getByLabel("Vendor").fill("Electric Co");
  await expenseDialog.getByLabel("Category").selectOption({ label: "Utilities" });
  await expenseDialog.getByLabel("Amount (EUR)").fill("50");
  await expenseDialog.getByLabel("Paid state").selectOption("paid");
  await expenseDialog.getByLabel("Notes (optional)").fill("September utility bill");
  await expenseDialog.getByRole("button", { name: "Log expense" }).click();
  await expect(expenseDialog.getByRole("alert")).toContainText("Expense could not be saved");
  await expenseDialog.getByRole("button", { name: "Log expense" }).click();
  await expect(expenseDialog).toHaveCount(0);
  await expect(page.getByText("Electric Co")).toBeVisible();
  await page.getByRole("button", { name: "Categories" }).click();
  await categoriesDialog.getByLabel("Category").selectOption({ label: "Utilities" });
  await categoriesDialog.getByLabel("Name").fill("Utilities & energy");
  await categoriesDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(categoriesDialog).toHaveCount(0);
  await page.getByRole("button", { name: "Categories" }).click();
  await categoriesDialog.getByLabel("Category").selectOption({ label: "Utilities & energy" });
  await categoriesDialog.getByRole("button", { name: "Archive category" }).click();
  await categoriesDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(categoriesDialog).toHaveCount(0);
  await expect(
    page.getByRole("row").filter({ hasText: "Electric Co" }).getByText("Utilities & energy"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Log expense" }).click();
  await expenseDialog.getByLabel("Vendor").fill("Weekly cleaning");
  await expenseDialog.getByLabel("Category").selectOption({ label: "Housekeeping" });
  await expenseDialog.getByLabel("Amount (EUR)").fill("25");
  await expenseDialog.getByLabel("Paid state").selectOption("paid");
  await expenseDialog.getByLabel("Repeat").selectOption("weekly");
  await expect(expenseDialog.getByLabel("Paid on")).toHaveCount(0);
  await expect(expenseDialog.getByText(/Paid recurring entries use each occurrence date/)).toBeVisible();
  await expenseDialog.getByRole("button", { name: "Save recurring expense" }).click();
  await expect(expenseDialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "Recurring expense scheduled." }),
  ).toBeVisible();
  failNextCategoryUpdate = true;
  await page.getByRole("button", { name: "Categories" }).click();
  await categoriesDialog.getByLabel("Category").selectOption({ label: "Housekeeping" });
  await categoriesDialog.getByLabel("Name").fill("Housekeeping & linen");
  await categoriesDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Categories changed elsewhere" }),
  ).toContainText("The list was refreshed");
  await page.getByRole("button", { name: "Categories" }).click();
  await categoriesDialog.getByLabel("Category").selectOption({ label: "Housekeeping" });
  await categoriesDialog.getByLabel("Name").fill("Housekeeping & linen");
  await categoriesDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(categoriesDialog).toHaveCount(0);
});
