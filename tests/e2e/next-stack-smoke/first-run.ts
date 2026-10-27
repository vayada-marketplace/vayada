import { expect, test, type Page } from "@playwright/test";

import { record, stringField } from "./support";

export type FirstRunHotel = {
  name: string;
  streetAddress: string;
  postalCode: string;
  city: string;
  /** ISO code; the first run takes the time zone and currency from it. */
  countryCode: string;
  receptionEmail: string;
  receptionPhone: string;
  room: { name: string; numberOfRooms: number; maxGuests: number; pricePerNight: string };
};

/** What the owner's first run left behind: the hotel and its live booking page. */
export type FirstRunResult = { propertyId: string; bookingUrl: string };

const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });
// The step layout renders its footer twice (desktop and phone); only one of them is visible.
const proceed = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });

/**
 * Takes a new owner through Booking Admin's first run (VAY-2247) from "Your hotel" to "You're live",
 * as an owner does: the hotel, where it is, how guests reach it, the first room and its price, paying
 * at the hotel with the Commission plan (no Stripe), then Publish. The first run's one server call
 * sets the currency, rooms, payments, prices, calendar, guest rules and plan; the publish goes through
 * the same review as the setup's Booking Engine card. `onPropertyCreated` runs as soon as the hotel
 * exists, so cleanup can retire it even if a later step fails.
 */
export async function completeFirstRun(
  page: Page,
  hotel: FirstRunHotel,
  onPropertyCreated: (propertyId: string) => void,
): Promise<FirstRunResult> {
  const propertyId = await test.step("enter the hotel, its address and contacts", async () => {
    await expect(heading(page, "Your hotel")).toBeVisible();
    await field(page, "Hotel name").fill(hotel.name);
    await page.getByRole("radio", { name: "Hotel", exact: true }).click();
    await proceed(page).click();

    await expect(heading(page, "Where it is")).toBeVisible();
    // With a Google Maps key the step opens on the address search; the smoke types the address.
    const street = field(page, "Street and number");
    const manual = page.getByRole("button", { name: "Can't find it? Enter the address manually" });
    await expect(street.or(manual)).toBeVisible();
    if (await manual.isVisible()) await manual.click();
    await street.fill(hotel.streetAddress);
    await field(page, "Postal code").fill(hotel.postalCode);
    await field(page, "City").fill(hotel.city);
    await page
      .getByRole("combobox", { name: "Country", exact: true })
      .selectOption(hotel.countryCode);
    await proceed(page).click();

    await expect(heading(page, "How guests reach you")).toBeVisible();
    await field(page, "Reception email").fill(hotel.receptionEmail);
    // By role: the label carries a hidden required mark, and the country button next to it is
    // named "Reception phone country: …".
    await field(page, "Reception phone").fill(hotel.receptionPhone);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/hotel-setup/properties",
      { timeout: 45_000 },
    );
    await proceed(page).click();
    const response = await created;
    const body = await response.text();
    expect(response.ok(), `Creating the hotel returned ${response.status()}: ${body}`).toBe(true);
    const id = stringField(record(JSON.parse(body)), "propertyId");
    onPropertyCreated(id);
    return id;
  });

  await test.step("add the first room and its price", async () => {
    await expect(heading(page, "Your first room and price")).toBeVisible({ timeout: 45_000 });
    await field(page, "Room type name").fill(hotel.room.name);
    await field(page, "Rooms of this type").fill(String(hotel.room.numberOfRooms));
    await field(page, "Max guests").fill(String(hotel.room.maxGuests));
    await field(page, "Price per night").fill(hotel.room.pricePerNight);
    // The box itself is visually hidden behind a styled square; its label ticks it.
    const taxes = page.getByRole("checkbox", {
      name: /My prices include all mandatory taxes and fees/,
    });
    await page.getByText("My prices include all mandatory taxes and fees", { exact: true }).click();
    await expect(taxes).toBeChecked();
    await proceed(page).click();
  });

  await test.step("pay at the hotel on the Commission plan and run the first run", async () => {
    await expect(heading(page, "How guests pay")).toBeVisible();
    await page.getByRole("radio", { name: /^Commission\b/ }).check();
    const firstRun = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/hotel-setup/properties/${propertyId}/first-run`,
      { timeout: 120_000 },
    );
    await proceed(page).click();
    const response = await firstRun;
    expect(
      response.ok(),
      `The first run returned ${response.status()}: ${await response.text()}`,
    ).toBe(true);
    // Commission needs no Stripe checkout: the first run goes straight on to the review.
    await expect(heading(page, "Does this look right?")).toBeVisible({ timeout: 45_000 });
  });

  const bookingUrl = await test.step("publish the booking page", async () => {
    const live = heading(page, `${hotel.name} is open for bookings`);
    const publish = page.getByRole("button", { name: "Publish booking page" });
    // The publish waits for the review to say ready; a check that isn't ready yet ("usually sorts
    // itself out within a minute") or a refused publish offers Try again, as it does for owners.
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await expect(async () => {
      if (await live.isVisible()) return;
      if (await retry.isVisible()) await retry.click();
      else if (await publish.isEnabled()) await publish.click();
      await expect(live).toBeVisible({ timeout: 20_000 });
    }).toPass({ timeout: 180_000, intervals: [2_000, 5_000, 10_000] });
    const href = await page
      .getByRole("region", { name: `${hotel.name} is open for bookings` })
      .getByRole("link")
      .getAttribute("href", { timeout: 10_000 })
      .catch(() => null);
    // Without a link the page is published but not served at its address yet (VAY-2193).
    if (!href) throw new Error("The live screen shows no booking page link.");
    return href;
  });

  return { propertyId, bookingUrl };
}
