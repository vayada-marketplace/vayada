import { expect, type Page } from "@playwright/test";

/** VAY-2195: /book is a series of steps. From a filled room form, through the extras (when the
 * hotel offers any) and the guest's details, to the payment step, choosing how to pay there. */
export async function continueToPayment(
  page: Page,
  { method, extras = false }: { method?: string; extras?: boolean } = {},
) {
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  if (extras) await page.getByRole("button", { name: "Continue to your details" }).click();
  await expect(page).toHaveURL(/[?&]step=details/);
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/[?&]step=payment/);
  if (method) await choosePayment(page, method);
}

const paymentNames: Record<string, RegExp> = {
  pay_at_property: /^Pay at the hotel/,
  card: /^Pay by card now/,
  bank_transfer: /^Bank transfer/,
  paypal: /^PayPal/,
};

/** The payment step's way to pay, as a guest picks it. */
export function paymentOption(page: Page, method: string) {
  return page
    .getByRole("radiogroup", { name: "Payment preference" })
    .getByRole("radio", { name: paymentNames[method] });
}

export async function choosePayment(page: Page, method: string) {
  await paymentOption(page, method).click();
  await expect(paymentOption(page, method)).toHaveAttribute("aria-checked", "true");
}

/** The total in the payment step's order summary ("€240"). */
export function orderTotal(page: Page) {
  return page.getByRole("complementary", { name: "Order Summary" }).getByTestId("stay-total");
}

/** The details step's required fields, as a guest fills them in. */
export async function fillGuestDetails(page: Page) {
  await page.getByLabel("First name").fill("Ada");
  await page.getByLabel("Last name").fill("Lovelace");
  await page.getByLabel("Email", { exact: true }).fill("ada@example.test");
  // "Phone", or "Phone (optional)" when our guest rules don't ask for one.
  await page.getByRole("textbox", { name: /^Phone( \(optional\))?$/ }).fill("+49 30 1234567");
}

/** A price for whatever is asked (each room 100.00 a stay, pay at the property) and its guest
 * rules, for specs that pass through the steps without testing the price itself. */
export async function mockAnyPrice(page: Page) {
  const quotes = new Map<string, { issuedAt: string; expiresAt: string }>();
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    const quoteId = `11111111-1111-4111-8111-${String(quotes.size + 1).padStart(12, "0")}`;
    const times = {
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    quotes.set(quoteId, times);
    const total = String(10000 * selection.rooms.length);
    return route.fulfill({
      json: {
        version: "public-booking-quote.v1",
        quoteId,
        replayed: false,
        checkIn: selection.checkIn,
        checkOut: selection.checkOut,
        currency: selection.currency,
        paymentMethod,
        acceptanceMode: "instant",
        ...times,
        totalMinor: total,
        dueNowMinor: paymentMethod === "pay_at_property" ? "0" : total,
        dueLaterMinor: paymentMethod === "pay_at_property" ? total : "0",
        lines: selection.rooms.map((room: { selectionId: string }) => ({
          kind: "room",
          selectionId: room.selectionId,
          amountMinor: "10000",
        })),
        rooms: selection.rooms.map((room: { selectionId: string }) => ({
          selectionId: room.selectionId,
          mealPlan: "room_only",
          cancellation: { kind: "non_refundable" },
          payment: { kind: "full", acceptedMethods: [paymentMethod] },
        })),
      },
    });
  });
  await page.route("**/bookings/quotes/*/guest-disclosure", (route) => {
    const quoteId = route.request().url().split("/quotes/")[1]!.split("/")[0]!;
    return route.fulfill({
      json: {
        version: "public-quote-guest-disclosure.v1",
        quoteId,
        quoteEvidenceId: `sha256:${"a".repeat(64)}`,
        guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
        ...quotes.get(quoteId),
        checkedAt: new Date().toISOString(),
        propertyTimeZone: "Europe/Berlin",
        choices: {
          defaultGuestLanguage: "en",
          childrenEnabled: true,
          adultAgeThreshold: 18,
          phoneRequired: true,
          arrivalTimeEnabled: false,
          specialRequestsEnabled: false,
          checkInTime: "15:00",
          checkInUntil: null,
          checkOutFrom: null,
          checkOutTime: "11:00",
        },
      },
    });
  });
}
