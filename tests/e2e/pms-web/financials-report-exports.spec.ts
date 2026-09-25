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

test("requests dashboard and revenue CSVs for the selected dates", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route((url) => url.pathname === `${root}/access`, route => route.fulfill({ status: 204 }));
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
    (url) => url.pathname === `${root}/revenue`,
    (route) =>
      route.fulfill({
        json: {
          ...envelope,
          summary: {
            grossRoom: metric("100"),
            otaCommission: metric("10"),
            netRoom: metric("90"),
            upsell: metric("0"),
            nights: { value: 1, absoluteChange: 0, percentChange: null },
            adr: metric("100"),
            attachRate: { value: "0", absoluteChange: "0", percentChange: null },
          },
          channels: [],
          directSources: [],
          upsells: [],
          roomTypes: [],
        },
      }),
  );
  const requests: Array<{ tab: string; filters: unknown }> = [];
  let checks = 0;
  await page.route(
    (url) => url.pathname === `${root}/exports`,
    async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        json: { item: { resourceId: `export-${requests.length}`, state: "pending" } },
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith(`${root}/exports/`),
    async (route) => {
      checks += 1;
      await route.fulfill({
        json: {
          item:
            checks === 1
              ? { state: "pending" }
              : {
                  state: "ready",
                  download: {
                    url: "https://files.example/report.csv",
                    expiresAt: "2099-01-01T00:00:00.000Z",
                  },
                },
        },
      });
    },
  );
  await page.goto("/financials");
  await page.getByLabel("As of date").fill("2026-09-16");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("being prepared");
  await page.getByRole("button", { name: "Check export", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
    "href",
    "https://files.example/report.csv",
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ tab: "dashboard", filters: { asOf: "2026-09-16" } });
  await page.getByRole("tab", { name: "Revenue", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveCount(0);
  await page.getByLabel("From", { exact: true }).fill("2026-08-01");
  await page.getByLabel("To", { exact: true }).fill("2026-08-31");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download CSV" })).toBeVisible();
  expect(requests[1]).toMatchObject({
    tab: "revenue",
    filters: { from: "2026-08-01", to: "2026-08-31" },
  });
});
