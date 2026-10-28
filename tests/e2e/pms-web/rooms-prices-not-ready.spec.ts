import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// Pricing terms need a UUID room type, unlike the shared mock's "room_type_alpine_suite".
const ROOM = "cccccccc-0000-4000-8000-00000000000c";
const roomType = { ...pmsWebRoomType, roomTypeId: ROOM, name: "Lake Loft" };

// VAY-2383: a hotel made by the old setup has no payment settings, so the server refuses its first prices
// (403 at pricing-v2/prepare). The Prices tab must say so before the hotel types, and after a refused save
// it must say the prices were not saved and what to set up first, never that the edits are kept.

function paymentSettings(overrides: Record<string, unknown>) {
  return {
    paymentSettings: {
      stripeConnectAccountId: null,
      stripeConnectOnboarded: false,
      platformFeeType: "none",
      platformFeeValue: 0,
      platformFeeWithAffiliate: 0,
      payAtPropertyEnabled: false,
      onlineCardPayment: false,
      bankTransfer: false,
      xenditPaymentsEnabled: false,
      paymentProvider: "stripe",
      xenditChannelCode: null,
      xenditAccountNumber: null,
      xenditAccountHolderName: null,
      defaultCurrency: "EUR",
      ...overrides,
    },
    cancellationPolicy: { freeCancellationDays: 7, partialRefundPct: 50 },
  };
}

/** The unpriced room's Prices tab; every prepare is refused with this finance reason. */
async function openRefusedPrices(page: Page, settings: Record<string, unknown>, reason: string) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/payment-settings`, (route) =>
    route.fulfill({ json: paymentSettings(settings) }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [roomType],
        sourceFreshness: {},
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${ROOM}`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        item: roomType,
        sourceFreshness: {},
      },
    }),
  );
  const prepares: Record<string, unknown>[] = [];
  const savedTerms = new Map<string, Record<string, unknown>>();
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2/**`, async (route) => {
    const request = route.request();
    const suffix = new URL(request.url()).pathname.split("/pricing-v2")[1] ?? "";
    const terms = suffix.match(/\/rooms\/([^/]+)\/offers\/([^/]+)\/terms$/);
    if (terms && request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const saved = {
        roomTypeId: terms[1],
        offerId: decodeURIComponent(terms[2]!),
        revision: "77777777-7777-4777-8777-000000000001",
        cancellation: body["cancellation"],
        payment: body["payment"],
      };
      savedTerms.set(saved.offerId, saved);
      return route.fulfill({ json: saved });
    }
    // After the refusal the room stays on the page as unsaved work, and its option's terms are read back.
    if (terms && request.method() === "GET") {
      const saved = savedTerms.get(decodeURIComponent(terms[2]!));
      return saved
        ? route.fulfill({ json: saved })
        : route.fulfill({ status: 404, json: { code: "not_found" } });
    }
    if (suffix === "/prepare" && request.method() === "POST") {
      prepares.push(request.postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 403, json: { code: "denied", reason } });
    }
    // The shared context routes answer the reads (no prices yet, no card, no bank transfer).
    return route.fallback();
  });
  await page.goto(`/rooms/${ROOM}?tab=prices`);
  await expect(page.getByLabel("Room price per night")).toBeVisible();
  return prepares;
}

const alert = (page: Page) => page.locator("main").getByRole("alert").first();

// No page-health watch in these tests: the refused prepare (403) is their point and logs to the console.
test("says before typing that payments aren't set up, and after a refused save that nothing was saved", async ({
  page,
}) => {
  const prepares = await openRefusedPrices(page, {}, "payments_disabled");
  // Before any typing: the page already knows from Payment settings that a save would be refused.
  const notice = page.locator("main").getByRole("status").filter({ hasText: "can't be saved" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Settings → Payments");
  await expect(notice).toContainText("Settings → General → Localization");
  await page.getByLabel("Room price per night").fill("1500000");
  await page.getByLabel("Currency code (for example EUR)").fill("IDR");
  await page.getByRole("checkbox", { name: "Pay at property" }).check();
  await page.getByRole("button", { name: "Save and publish" }).click();
  await expect(alert(page)).toBeVisible();
  expect(prepares).toHaveLength(1);
  await expect(alert(page)).toContainText("not saved");
  await expect(alert(page)).toContainText("Booking Admin");
  await expect(alert(page)).toContainText("Settings → Payments");
  await expect(alert(page)).toContainText("stays on this page only until you leave");
  await expect(alert(page)).not.toContainText("edits are kept");
  // Nothing was saved: the room's typed prices stay on the page as unsaved changes, and no success shows.
  await expect(page.locator("main").getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect(page.locator("main").getByText("Prices saved.")).toHaveCount(0);
});

test("names the payment currency when the prices are in another one", async ({ page }) => {
  await openRefusedPrices(page, { payAtPropertyEnabled: true }, "currency_mismatch");
  // Pay at the hotel is on, so no notice before typing.
  await expect(
    page.locator("main").getByRole("status").filter({ hasText: "can't be saved" }),
  ).toHaveCount(0);
  await page.getByLabel("Room price per night").fill("1500000");
  await page.getByLabel("Currency code (for example EUR)").fill("IDR");
  await page.getByRole("button", { name: "Save and publish" }).click();
  await expect(alert(page)).toBeVisible();
  await expect(alert(page)).toContainText("not saved");
  await expect(alert(page)).toContainText("takes payments in EUR");
  await expect(alert(page)).toContainText("Settings → General → Localization");
  await expect(alert(page)).not.toContainText("edits are kept");
});
