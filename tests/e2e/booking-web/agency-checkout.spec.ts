import { expect, test, type Page, type Request } from "@playwright/test";

import {
  AGENCY_SLUG,
  agencyUrl,
  mockAgencyPage,
  searchDates,
  staySlug,
} from "../support/agencyPageMocks";
import { continueToPayment, mockAnyPrice } from "../support/bookFlow";
import { mockStayHotel, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { mockStripe } from "../support/stripeFake";

// VAY-2462: after "Continue" on a stay's page, today's checkout runs for that one stay on the
// agency's address (`/stays/<slug>/book`) under the agency's slim bar, and so does the booking's
// page after paying. The stay keeps its own payment (its Stripe account), policies and emails; the
// booking and its funnel events say they came through the agency's page.

const { checkIn, checkOut } = searchDates();
const search = `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`;
const escape = staySlug("escape");
const offer = `pricing-offer.v2:${"a".repeat(64)}`;
const reference = "VAY-77777777777747778777777777777777";
const bookingId = "88888888-8888-4888-8888-888888888888";

/** The agency's page with The Escape's own hotel, prices and payment methods. Every booking-web
 * call is kept, to show which stay each one was for. */
async function open(page: Page, methods: string[]) {
  const calls: Request[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/booking-web/hotels/")) calls.push(request);
  });
  // Anything of The Escape's not answered below (its booking's later reads) has nothing to say.
  await page.route(`**/api/booking-web/hotels/${escape}/**`, (route) =>
    route.fulfill({ status: 404, json: { statusCode: 404, message: "Not found." } }),
  );
  await mockAgencyPage(page);
  await mockStayHotel(page, escape, "The Escape Villa Ubud");
  await page.route(`**/api/booking-web/hotels/${escape}/checkout-config`, (route) =>
    route.fulfill({
      json: { addons: [], payAtPropertyEnabled: false, bookingPagePaymentMethods: methods },
    }),
  );
  await mockAnyPrice(page);
  return calls;
}

/** The stay's page, its room chosen, and on to its checkout with the dark bar's Continue. */
async function chooseAndContinue(page: Page, baseURL: string | undefined) {
  await page.goto(agencyUrl(baseURL, `/stays/${escape}${search}`));
  await page.getByTestId("select-rate-suite").click();
  await page.getByTestId("agency-choice-bar").getByRole("link", { name: "Continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/stays/${escape}/book\\?.*offer=`));
}

function stayOf(request: Request) {
  return new URL(request.url()).pathname.split("/api/booking-web/hotels/")[1]!.split("/")[0];
}

/** The stays the page's booking-web calls were for. The address's own hotel read (it has none:
 * it is the agency's), as on every agency page, is not one of them. */
function staysAsked(calls: Request[]) {
  const own = calls.filter((call) => stayOf(call) === AGENCY_SLUG);
  expect(own.every((call) => call.method() === "GET")).toBe(true);
  return new Set(calls.map(stayOf).filter((slug) => slug !== AGENCY_SLUG));
}

test("books a room of the stay by card, on the agency's address and in its look", async ({
  page,
  baseURL,
}) => {
  const calls = await open(page, ["card"]);
  const stripe = await mockStripe(page);
  // The guest says yes to analytics for this stay, which the events are recorded for.
  await page.addInitScript(
    (slug) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version: 2, analytics: true }),
      ),
    escape,
  );
  const events: { hotelSlug: string; eventType: string; metadata: Record<string, unknown> }[] = [];
  await page.route("**/api/booking-web/events", (route) => {
    events.push(JSON.parse(route.request().postData()!));
    return route.fulfill({ status: 204, body: "" });
  });
  let accepted: Request | undefined;
  await page.route(`**/api/booking-web/hotels/*/bookings/quotes/*/accept`, (route) => {
    accepted = route.request();
    return route.fulfill({
      json: {
        kind: "payment_required",
        bookingId,
        bookingReference: reference,
        payment: {
          provider: "stripe",
          clientSecret: "pi_escape2462_secret_test",
          stripeAccountId: "acct_escape2462",
          paymentIntentId: "pi_escape2462",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      },
    });
  });
  await page.route(`**/api/booking-web/hotels/*/bookings/quotes/*/accept/payment`, (route) =>
    route.fulfill({
      json: { kind: "accepted", bookingId, bookingReference: reference, replayed: false },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await chooseAndContinue(page, baseURL);
  // The agency's slim bar (its name and Contact), today's steps, and the stay's own footer.
  const nav = page.getByRole("navigation").first();
  await expect(nav.getByRole("link", { name: "The Travel Ubud" })).toBeVisible();
  // Its Contact is the agency's (its WhatsApp), not the stay's.
  await nav.getByRole("button", { name: "Contact" }).click();
  await expect(page.getByText("+6281234567890")).toBeVisible();
  await nav.getByRole("button", { name: "Contact" }).click();
  await expect(page.getByText("Review & pay").first()).toBeVisible();
  await expect(page.locator("footer")).toContainText("The Escape Villa Ubud");

  await continueToPayment(page, { method: "card" });
  await page.getByLabel(/I agree to the cancellation policy/).check();
  await page.getByRole("button", { name: "Continue to card details" }).click();
  await page.getByRole("button", { name: "Pay and confirm booking" }).click();

  // The booking's page, on the agency's address under the stay.
  await expect(page).toHaveURL(new RegExp(`/stays/${escape}/booking/${reference}$`));
  await expect(page.getByText("The Escape Villa Ubud").first()).toBeVisible();
  await expect(
    page.getByRole("navigation").first().getByRole("link", { name: "The Travel Ubud" }),
  ).toBeVisible();

  // The stay's own Stripe account, and back to the agency's address after any card check.
  const confirm = await stripe();
  expect(confirm?.account).toBe("acct_escape2462");
  const back = new URL(confirm!.returnUrl);
  expect(back.host).toBe(new URL(agencyUrl(baseURL)).host);
  expect(back.pathname).toBe(`/stays/${escape}/book`);
  // The booking names the agency page; it and every other booking call are the stay's own.
  expect(accepted?.headers()["x-vayada-agency-page"]).toBe(AGENCY_SLUG);
  expect(accepted?.postDataJSON()).not.toHaveProperty("via");
  expect(staysAsked(calls)).toEqual(new Set([escape]));
  // Its funnel events too, for this stay.
  const types = events.map((event) => event.eventType);
  expect(types).toEqual(
    expect.arrayContaining([
      "page_visit",
      "step_viewed",
      "complete_booking_clicked",
      "booking_completed",
    ]),
  );
  for (const event of events) {
    expect(event.hotelSlug).toBe(escape);
    expect(event.metadata.via).toBe("agency_page");
  }
  expect(errors).toEqual([]);
});

test("opens a bank-transfer reservation's own link on the agency's address", async ({
  page,
  baseURL,
}) => {
  const calls = await open(page, ["bank_transfer"]);
  const token = "t".repeat(43);
  await page.route(`**/api/booking-web/hotels/*/bookings/quotes/*/accept`, (route) => {
    const acceptedAt = new Date(Date.now() - 500).toISOString();
    return route.fulfill({
      json: {
        kind: "payment_pending",
        bookingId,
        acceptanceId: "99999999-9999-4999-8999-999999999999",
        acceptedAt,
        bookingReference: reference,
        payment: {
          method: "bank_transfer",
          amountMinor: "20000",
          currency: "EUR",
          deadlineAt: new Date(Date.parse(acceptedAt) + 48 * 3600_000).toISOString(),
        },
        checkedAt: new Date().toISOString(),
        confirmationToken: token,
        confirmationTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
  });
  await page.route(`**/api/booking-web/hotels/${escape}/bookings/confirmation`, (route) =>
    route.fulfill({
      json: {
        id: bookingId,
        bookingReference: reference,
        status: "pending_payment",
        paymentStatus: "unpaid",
        paymentMethod: "bank_transfer",
        hotelName: "The Escape Villa Ubud",
        roomName: "Suite",
        guestFirstName: "Ada",
        guestLastName: "Lovelace",
        guestEmail: "ada@example.test",
        checkIn,
        checkOut,
        nights: 2,
        adults: 2,
        children: 0,
        numberOfRooms: 1,
        currency: "EUR",
        totalAmount: 200,
        createdAt: new Date().toISOString(),
        bankTransferDetails: "IBAN: ID12 3456 7890",
      },
    }),
  );

  await chooseAndContinue(page, baseURL);
  await continueToPayment(page);
  await page.getByLabel(/I agree to the cancellation policy/).check();
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/stays/${escape}/confirmation\\?booking=${reference}&token=${token}$`),
  );
  await expect(page.getByText("IBAN: ID12 3456 7890", { exact: true })).toBeVisible();
  expect(staysAsked(calls)).toEqual(new Set([escape]));
});

test("a room this stay doesn't have goes back to this stay's rooms, asking no other stay", async ({
  page,
  baseURL,
}) => {
  const calls = await open(page, ["card"]);
  // Another stay's room, as if carried over from its page.
  const theirs = `pricing-offer.v2:${"b".repeat(64)}`;
  await page.goto(agencyUrl(baseURL, `/stays/${escape}/book${search}&offer=${theirs}`));
  await expect(page).toHaveURL(new RegExp(`/stays/${escape}\\?checkIn=${checkIn}`));
  await expect(page.getByTestId("agency-stay-box")).toContainText("The Escape Villa Ubud");
  expect(calls.length).toBeGreaterThan(0);
  expect(staysAsked(calls)).toEqual(new Set([escape]));
});

test("a stay the agency doesn't show has no checkout there, nor a hotel's address", async ({
  page,
  baseURL,
}) => {
  await open(page, ["card"]);
  for (const path of [
    `/stays/other-hotel/book${search}&offer=${offer}`,
    `/stays/other-hotel/booking/${reference}`,
  ]) {
    await page.goto(agencyUrl(baseURL, path));
    await expect(
      page.getByRole("heading", { name: "This booking page isn't online right now" }),
    ).toBeVisible();
  }

  // A hotel's own address has no stay pages at all.
  await page.goto(`/stays/${escape}/book${search}&offer=${offer}`);
  await expect(page).toHaveURL(new RegExp(`^http://${SEEDED_BOOKING_SLUG}\\.`));
  await expect(
    page.getByRole("heading", { name: "This booking page isn't online right now" }),
  ).toBeVisible();
});
