import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import {
  arrayField,
  futureStay,
  publicApi,
  record,
  stringField,
  type SmokeEnvironment,
} from "./support";

export type Stay = ReturnType<typeof futureStay>;
export type BookingResource = {
  bookingId: string;
  email: string;
  mode: "instant" | "request";
  resolved: boolean;
  slug: string;
};
export type GuestBooking = { bookingId: string; bookingReference: string; email: string };

const GUEST = { firstName: "Taylor", lastName: "Smoke", phone: "+49 30 5550104" };

/** The analytics prompt opens on every page until it's answered and can sit over the page's
 * buttons; a guest who declines isn't asked again on that hotel's pages. */
async function declineAnalytics(page: Page): Promise<void> {
  const reject = page.getByRole("button", { name: "Reject analytics" });
  if (await reject.isVisible()) await reject.click();
}

/** The guest's name as PMS shows it. */
export const GUEST_NAME = `${GUEST.firstName} ${GUEST.lastName}`;

export function guestEmail(environment: SmokeEnvironment): string {
  return `qa-next-guest-${environment.runId}@${environment.emailDomain}`;
}

/** One room type's row of the room cards' read-only stay prices (VAY-2190), for two adults. */
export async function stayRoom(
  request: APIRequestContext,
  slug: string,
  roomTypeId: string,
  stay: Stay,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ ...stay, adults: "2", children: "0" });
  const prices = await publicApi(request).json<Record<string, unknown>>(
    "GET",
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/pricing-offers/stay-prices?${query}`,
  );
  expect(prices.version).toBe("public-pricing-stay-prices.v1");
  const room = arrayField(prices, "rooms")
    .map(record)
    .find((candidate) => candidate.roomTypeId === roomTypeId);
  if (!room) throw new Error(`Stay prices do not list room type ${roomTypeId}.`);
  return room;
}

/** The rooms a guest can still book for the stay; stay prices name the count once three or
 * fewer are left. */
export async function roomsLeft(
  request: APIRequestContext,
  slug: string,
  roomTypeId: string,
  stay: Stay,
): Promise<number | null> {
  const room = await stayRoom(request, slug, roomTypeId, stay);
  if (room.availability === "sold_out") return 0;
  return typeof room.roomsLeft === "number" ? room.roomsLeft : null;
}

export async function waitForRoomsLeft(
  request: APIRequestContext,
  slug: string,
  roomTypeId: string,
  stay: Stay,
  expected: number,
): Promise<void> {
  await expect
    .poll(() => roomsLeft(request, slug, roomTypeId, stay), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe(expected);
}

/**
 * A guest books the stay on the hotel's live booking page, as guests do: the hotel page with the
 * dates, the room card's rate, /book's details and review, paying at the hotel. The booking is
 * registered for cleanup as soon as the API accepts it.
 */
export async function bookOnLivePage(input: {
  browser: Browser;
  bookingUrl: string;
  bookings: BookingResource[];
  environment: SmokeEnvironment;
  roomName: string;
  roomTypeId: string;
  slug: string;
  stay: Stay;
}): Promise<GuestBooking> {
  const { bookings, roomTypeId, slug, stay } = input;
  const email = guestEmail(input.environment);
  const context = await input.browser.newContext();
  try {
    const page = await context.newPage();
    const hotelPage = new URL(input.bookingUrl);
    for (const [key, value] of Object.entries({ ...stay, adults: "2" }))
      hotelPage.searchParams.set(key, value);
    await page.goto(hotelPage.toString());
    const card = page.getByTestId(`room-card-${roomTypeId}`);
    await expect(card.getByRole("heading", { name: input.roomName })).toBeVisible({
      timeout: 45_000,
    });
    await declineAnalytics(page);
    await page.getByTestId(`select-rate-${roomTypeId}`).click();
    await expect(page).toHaveURL(/\/book\?.*offer=/);

    // A hotel without extras opens on the guest's details; with extras, Extras comes first.
    const details = page.getByRole("heading", { name: "Who’s staying?" });
    // VAY-2391: the Extras step's Continue says "Continue without extras" until one is added.
    const extras = page.getByRole("button", {
      name: /^Continue (to your details|without extras)$/,
    });
    await expect(details.or(extras)).toBeVisible({ timeout: 45_000 });
    if (await extras.isVisible()) await extras.click();
    await expect(details).toBeVisible();
    await page.getByLabel("First name").fill(GUEST.firstName);
    await page.getByLabel("Last name").fill(GUEST.lastName);
    await page.getByLabel("Email", { exact: true }).fill(email);
    // "Phone", or "Phone (optional)" when the hotel's guest rules don't ask for one.
    await page.getByRole("textbox", { name: /^Phone( \(optional\))?$/ }).fill(GUEST.phone);
    await page.getByRole("button", { name: "Continue to review" }).click();

    await expect(page.getByRole("heading", { name: "Review & pay" })).toBeVisible();
    await expect(
      page
        .getByRole("radiogroup", { name: "Payment preference" })
        .getByRole("radio", { name: /^Pay at the hotel/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByLabel(/^I agree to the cancellation policy/).check();
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/accept") &&
        new URL(response.url()).pathname.includes(`/hotels/${slug}/bookings/quotes/`),
      { timeout: 45_000 },
    );
    await page.getByRole("button", { name: "Confirm booking" }).click();
    const response = await accepted;
    const body = record(await response.json());
    expect(response.ok(), JSON.stringify(body)).toBe(true);
    const booking = {
      bookingId: stringField(body, "bookingId"),
      bookingReference: stringField(body, "bookingReference"),
      email,
    };
    bookings.push({ bookingId: booking.bookingId, email, mode: "instant", resolved: false, slug });
    // Online booking requests are off in production, so the hotel books instantly.
    expect(body.kind).toBe("accepted");
    await expect(page).toHaveURL(new RegExp(`/booking/${booking.bookingReference}$`), {
      timeout: 45_000,
    });
    await expect(page.getByText(input.roomName, { exact: true }).first()).toBeVisible();
    return booking;
  } finally {
    await context.close();
  }
}

/** The guest looks the booking up on the hotel's page and cancels it there (free until 3 days
 * before arrival, so nothing is charged). */
export async function cancelOnLivePage(input: {
  browser: Browser;
  bookingUrl: string;
  booking: GuestBooking;
  resource: BookingResource;
}): Promise<void> {
  const context = await input.browser.newContext();
  try {
    const page = await context.newPage();
    const lookup = new URL("/en/my-booking", input.bookingUrl);
    lookup.searchParams.set("reference", input.booking.bookingReference);
    lookup.searchParams.set("email", input.booking.email);
    await test.step("open the booking from its reference and email", async () => {
      await page.goto(lookup.toString());
      const cancel = page.getByRole("button", { name: "Cancel Booking" });
      await expect(cancel).toBeVisible({ timeout: 45_000 });
      await declineAnalytics(page);
      await cancel.click();
    });
    const dialog = page.getByText("Cancel This Booking?").locator("..");
    await expect(dialog).toContainText("Free cancellation");
    // The page cancels by the id its lookup returned.
    const cancelled = page.waitForResponse(
      (response) => {
        const path = new URL(response.url()).pathname;
        return (
          response.request().method() === "POST" &&
          path.includes(`/hotels/${input.resource.slug}/bookings/`) &&
          path.endsWith("/cancel")
        );
      },
      { timeout: 45_000 },
    );
    await page.getByRole("button", { name: "Yes, Cancel" }).click();
    const response = await cancelled;
    expect(response.ok(), await response.text()).toBe(true);
    input.resource.resolved = true;
    await expect(page.getByText("Your booking has been cancelled.")).toBeVisible();
  } finally {
    await context.close();
  }
}
