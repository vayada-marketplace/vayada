import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
} from "../support/pmsWebMocks";

const folioId = "a6853000-0000-4000-8000-000000000001";
const secondFolioId = "c6853000-0000-4000-8000-000000000002";
const exportId = "b6853000-0000-4000-8000-000000000001";
let state: "draft" | "ready" = "draft";
const total = { amount: "125.00", currency: "EUR" };

test("prepares, finalizes, and exports operational folios without invoice claims", async ({
  page,
}) => {
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
  const root = `/api/finance/properties/${PMS_WEB_PROPERTY_ID}/financials`;
  const summary = () => ({
    folioId,
    bookingId: null,
    revision: state === "draft" ? 1 : 2,
    state,
    serviceFrom: "2026-09-01",
    serviceTo: "2026-09-02",
    total,
    createdAt: "2026-09-01T10:00:00.000Z",
  });
  const detail = () => ({
    ...summary(),
    recipient: { name: "Ada Lovelace", email: "ada@example.com" },
    lines: [
      {
        lineId: "line-1",
        kind: "room",
        description: "Alpine Suite",
        quantity: "1",
        total,
        serviceOn: "2026-09-01",
      },
    ],
    paymentRefs: [{ paymentId: "payment-ada", amount: { amount: "50.00", currency: "EUR" } }],
  });
  await page.route(
    (url) => url.pathname === `${root}/folios`,
    async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        expect(body.recipient.name).toBe("Grace Hopper");
        expect(body.lines[0].source.type).toBe("manual");
        expect(JSON.stringify(body)).not.toContain("invoice");
        return route.fulfill({ status: 201, json: { resourceId: folioId, revision: 1 } });
      }
      if (new URL(route.request().url()).searchParams.get("cursor") === "more") {
        return route.fulfill({
          json: {
            currency: "EUR",
            page: {
              items: [{ ...summary(), folioId: secondFolioId }],
              nextCursor: null,
            },
          },
        });
      }
      return route.fulfill({
        json: { currency: "EUR", page: { items: [summary()], nextCursor: "more" } },
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname === `${root}/folios/${folioId}` ||
      url.pathname === `${root}/folios/${folioId}/ready`,
    async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON().expectedRevision).toBe(1);
        state = "ready";
        return route.fulfill({ json: { resourceId: folioId, revision: 2 } });
      }
      return route.fulfill({ json: { item: detail() } });
    },
  );
  await page.route(
    (url) => url.pathname === `${root}/exports`,
    (route) => {
      expect(route.request().postDataJSON().filters.state).toBe("ready");
      return route.fulfill({
        status: 202,
        json: { item: { resourceId: exportId, state: "pending" } },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `${root}/exports/${exportId}`,
    (route) =>
      route.fulfill({
        json: {
          item: {
            resourceId: exportId,
            state: "ready",
            download: { url: "https://download.example/folios.csv" },
          },
        },
      }),
  );
  await page.route("https://download.example/folios.csv", (route) =>
    route.fulfill({ contentType: "text/csv", body: "folio_id\n" }),
  );

  await page.goto("/financials");
  await expect(page.getByRole("heading", { name: "Folios" })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include('[data-testid="folios-workspace"]').analyze())
      .violations,
  ).toEqual([]);
  await expect(page.getByText(/not official invoices/i)).toBeVisible();
  await page.getByRole("button", { name: "Load more folios" }).click();
  await expect(page.getByText(`Folio ${secondFolioId.slice(0, 8)}`)).toBeVisible();
  await page.getByRole("button", { name: "Prepare folio" }).click();
  await page.getByLabel("Guest or recipient").fill("Grace Hopper");
  await page.getByLabel("Service from").fill("2026-09-01");
  await page.getByLabel("Service to").fill("2026-09-02");
  await page.getByLabel("Line item").fill("Manual adjustment");
  await page.getByLabel("Amount (EUR)").fill("125.00");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Folio prepared as a draft");
  await expect(page.getByRole("region", { name: "Folio details" })).toContainText("Alpine Suite");
  await page.getByRole("button", { name: "Finalize folio" }).click();
  await expect(page.getByRole("status")).toContainText("Folio finalized");
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
    "href",
    "https://download.example/folios.csv",
  );
});
