import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

const firstKey = `pricing-offer.v2:${"a".repeat(64)}`;
const secondKey = `pricing-offer.v2:${"b".repeat(64)}`;
test("prices explicit mixed rooms and child ages, clears edits, and recovers from expired quotes", async ({
  page,
}, testInfo) => {
  await mockBookingApis(page, {
    supportedQuoteParameters: { adultAgeThreshold: 16, childrenSupported: false },
  });
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "suite",
            name: "Suite",
            offers: [{ publicOfferKey: firstKey, currency: "EUR", mealPlan: "breakfast" }],
          },
          {
            roomTypeId: "twin",
            name: "Twin",
            offers: [{ publicOfferKey: secondKey, currency: "EUR", mealPlan: "room_only" }],
          },
        ],
      },
    }),
  );
  let submitted: any;
  let requests = 0;
  await page.route("**/bookings/quote", (route) => {
    submitted = route.request().postDataJSON();
    requests++;
    const { selection, paymentMethod } = submitted;
    return route.fulfill({
      json: {
        version: "public-booking-quote.v1",
        quoteId: "11111111-1111-4111-8111-111111111111",
        replayed: false,
        checkIn: selection.checkIn,
        checkOut: selection.checkOut,
        currency: "EUR",
        paymentMethod,
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 2500).toISOString(),
        totalMinor: "31500",
        dueNowMinor: "0",
        dueLaterMinor: "31500",
        lines: selection.rooms.map((room: any, index: number) => ({
          kind: "room",
          selectionId: room.selectionId,
          amountMinor: index === 0 ? "20000" : "11500",
        })),
        rooms: selection.rooms.map((room: any) => ({
          selectionId: room.selectionId,
          mealPlan: "room_only",
          cancellation: { kind: "non_refundable" },
          payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
        })),
      },
    });
  });
  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
  await expect(page.getByRole("heading", { name: "Choose rooms and get a price" })).toBeVisible();
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const first = page.getByRole("group", { name: "Room 1", exact: true });
  const second = page.getByRole("group", { name: "Room 2", exact: true });
  await first.getByLabel("Room and meal option").selectOption(firstKey);
  await first.getByLabel(/Adults/).fill("2");
  await first.getByRole("button", { name: "Add child to room 1" }).click();
  await second.getByLabel("Room and meal option").selectOption(secondKey);
  await second.getByLabel(/Adults/).fill("1");
  await page.getByLabel("Payment preference").selectOption("pay_at_property");
  await expect(page.getByRole("button", { name: "Get price", exact: true })).toBeDisabled();
  expect(requests).toBe(0);
  await expect(
    first.getByLabel("Child 1: age at check-in").getByRole("option", { name: "17", exact: true }),
  ).toHaveCount(1);
  await first.getByLabel("Child 1: age at check-in").selectOption("0");
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 315.00", { exact: true })).toBeVisible();
  expect(submitted.selection.rooms.map((room: any) => [room.publicOfferKey, room.guests])).toEqual([
    [firstKey, { adults: 2, childAgesAtCheckIn: [0] }],
    [secondKey, { adults: 1, childAgesAtCheckIn: [] }],
  ]);
  expect(new Set(submitted.selection.rooms.map((room: any) => room.selectionId)).size).toBe(2);
  await first.getByLabel("Child 1: age at check-in").selectOption("7");
  await expect(page.getByRole("region", { name: "Your stay price" })).toHaveCount(0);
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 315.00", { exact: true })).toBeVisible();
  await expect(page.getByText(/This price has expired/)).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole("region", { name: "Your stay price" })).toHaveCount(0);
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 315.00", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("room-quote-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Get price", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("room-quote-mobile.png"), fullPage: true });
});

test("retries unavailable catalogue without inventing a room option", async ({
  page,
}, testInfo) => {
  await mockBookingApis(page);
  let unavailable = true;
  await page.route("**/pricing-offers", (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { version: "public-pricing-offers.v1", rooms: [] } }),
  );
  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}`);
  await expect(page.getByRole("button", { name: "Retry room options" })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Retry room options" }).click();
  await expect(page.getByText("Room options are currently unavailable.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get price", exact: true })).toHaveCount(0);
});
