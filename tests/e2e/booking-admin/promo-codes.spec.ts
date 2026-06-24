import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROMO_CODES_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin promo-code settings cutover", () => {
  test("manages promo codes through the TypeScript contract", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");

    await mockBookingAdminBookingFlow(page);

    const contractRequests: Array<{ method: string; pathname: string }> = [];
    const typedWrites: Array<{ method: string; pathname: string; body?: unknown }> = [];
    let promoCodes = [
      {
        promoCodeId: "promo_summer20",
        hotelId: BOOKING_ADMIN_HOTEL_ID,
        propertyId: "property_alpenrose",
        code: "SUMMER20",
        discountType: "percentage",
        discountValue: "20.00",
        currency: null,
        validFrom: "2026-07-01",
        validUntil: "2026-08-31",
        isActive: true,
        maxUses: 50,
        useCount: 3,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ];
    await page.route(`**${BOOKING_ADMIN_PROMO_CODES_PATH}**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      contractRequests.push({ method: request.method(), pathname });

      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const created = {
          promoCodeId: "promo_spring25",
          hotelId: BOOKING_ADMIN_HOTEL_ID,
          propertyId: "property_alpenrose",
          code: body.code,
          discountType: body.discountType,
          discountValue: body.discountValue,
          currency: body.currency,
          validFrom: body.validFrom,
          validUntil: body.validUntil,
          isActive: body.isActive,
          maxUses: body.maxUses,
          useCount: 0,
          createdAt: "2026-06-01T10:05:00.000Z",
          updatedAt: "2026-06-01T10:05:00.000Z",
        };
        typedWrites.push({ method: "POST", pathname, body });
        promoCodes = [...promoCodes, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }

      if (request.method() === "PATCH") {
        const body = request.postDataJSON();
        const promoCodeId = pathname.split("/").pop();
        const updatedAt = "2026-06-01T10:10:00.000Z";
        const updated = promoCodes
          .filter((item) => item.promoCodeId === promoCodeId)
          .map((item) => ({ ...item, ...body, updatedAt }))[0];
        typedWrites.push({ method: "PATCH", pathname, body });
        promoCodes = promoCodes.map((item) =>
          item.promoCodeId === promoCodeId ? (updated ?? item) : item,
        );
        await route.fulfill({ json: updated });
        return;
      }

      if (request.method() === "DELETE") {
        const promoCodeId = pathname.split("/").pop();
        typedWrites.push({ method: "DELETE", pathname });
        promoCodes = promoCodes.filter((item) => item.promoCodeId !== promoCodeId);
        await route.fulfill({ status: 204 });
        return;
      }

      expect(request.method()).toBe("GET");
      await route.fulfill({ json: { promoCodes } });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Promos$/ }).click();

    await expect(page.getByText("SUMMER20")).toBeVisible();
    await page.getByRole("button", { name: "Add Promo Code" }).click();
    await page.getByLabel("Code").fill("spring25");
    await page.getByLabel("Discount Value").fill("25");
    await page.getByLabel("Valid From").fill("2026-07-01");
    await page.getByLabel("Valid Until").fill("2026-08-31");
    await page.getByLabel("Max Uses").fill("25");
    await page.getByRole("button", { name: "Create Promo Code" }).click();
    await expect(page.getByText("SPRING25")).toBeVisible();

    await page.getByRole("button", { name: "Edit SPRING25" }).click();
    await page.getByLabel("Code").fill("spring30");
    await page.getByLabel("Discount Value").fill("30");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("SPRING30")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete SPRING30" }).click();
    await expect(page.getByText("SPRING30")).not.toBeVisible();

    expect(contractRequests[0]).toEqual({
      method: "GET",
      pathname: BOOKING_ADMIN_PROMO_CODES_PATH,
    });
    expect(typedWrites).toEqual([
      {
        method: "POST",
        pathname: BOOKING_ADMIN_PROMO_CODES_PATH,
        body: {
          code: "SPRING25",
          discountType: "percentage",
          discountValue: "25.00",
          currency: null,
          validFrom: "2026-07-01",
          validUntil: "2026-08-31",
          isActive: true,
          maxUses: 25,
        },
      },
      {
        method: "PATCH",
        pathname: `${BOOKING_ADMIN_PROMO_CODES_PATH}/promo_spring25`,
        body: {
          code: "SPRING30",
          discountType: "percentage",
          discountValue: "30.00",
          currency: null,
          validFrom: "2026-07-01",
          validUntil: "2026-08-31",
          isActive: true,
          maxUses: 25,
        },
      },
      {
        method: "DELETE",
        pathname: `${BOOKING_ADMIN_PROMO_CODES_PATH}/promo_spring25`,
      },
    ]);

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
