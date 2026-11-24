import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, mockAnyPrice, paymentOption } from "../support/bookFlow";
import { mockStripe } from "../support/stripeFake";

// VAY-2571: the vayada Payment card step (VAY-2442) charges on Vayada's own Stripe account: no
// connected account, and the publishable key of the mode the hotel is in. A test hotel gets the
// test key, a live hotel the live key. On 19 Nov 2026 the booking page refused the live key and
// showed "We couldn't confirm your booking" before the card form (fixed in #4126). Stripe.js is
// the stand-in from stripeFake, so nothing reaches Stripe and no card is charged.
const offerKey = `pricing-offer.v2:${"a".repeat(64)}`;
const bookingId = "25710000-0000-4000-8000-000000000001";
const reference = "VAY-25710000000040008000000000000001";

for (const [mode, publishableKey] of [
  ["test", "pk_test_vay2571cardform"],
  ["live", "pk_live_vay2571cardform"],
] as const) {
  test(`takes a vayada Payment card step with the ${mode}-mode key`, async ({ page }) => {
    await mockBookingApis(page, { fontPairing: "grand-classic" });
    await mockAnyPrice(page);
    await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
      route.fulfill({
        json: {
          addons: [],
          payAtPropertyEnabled: true,
          bookingPagePaymentMethods: ["pay_at_property", "card"],
        },
      }),
    );
    const stripe = await mockStripe(page);
    await page.route("**/bookings/quotes/*/accept", (route) =>
      route.fulfill({
        json: {
          kind: "payment_required",
          bookingId,
          bookingReference: reference,
          payment: {
            provider: "stripe",
            clientSecret: "pi_vay2571_secret_cardform",
            // vayada Payment: Vayada's own account, so no connected account.
            stripeAccountId: null,
            publishableKey,
            paymentIntentId: "pi_vay2571",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        },
      }),
    );
    let paid = false;
    await page.route("**/bookings/quotes/*/accept/payment", (route) => {
      paid = true;
      return route.fulfill({
        json: { kind: "accepted", bookingId, bookingReference: reference, replayed: false },
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`/en/book?checkIn=2026-12-01&checkOut=2026-12-03&adults=2&offer=${offerKey}`);
    await expect(page).toHaveURL(/[?&]step=details/);
    await fillGuestDetails(page);
    await page.getByRole("button", { name: "Continue to review" }).click();
    await expect(page).toHaveURL(/[?&]step=payment/);
    await paymentOption(page, "card").click();
    await page.getByLabel(/I agree to the cancellation policy/).check();
    await page.getByRole("button", { name: "Continue to card details" }).click();

    // The card form opens instead of the "couldn't confirm" error.
    const pay = page.getByRole("button", { name: "Pay and confirm booking" });
    await expect(pay).toBeVisible();
    await expect(page.getByText(/couldn.t confirm your booking/i)).toHaveCount(0);
    await pay.click();

    // Stripe.js was made for Vayada's own account with the key of the hotel's mode.
    await expect.poll(async () => (await stripe())?.key).toBe(publishableKey);
    expect((await stripe())?.account).toBeUndefined();
    await expect.poll(() => paid).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/booking/${reference}`));
    expect(errors).toEqual([]);
  });
}
