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

const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });
// The step layout renders its footer twice (desktop and phone); only one of them is visible.
const proceed = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });

/** Where Booking Admin's four-step setup left the owner: the hotel and its room, before prices and publish. */
export type FourStepSetupResult = { propertyId: string; roomTypeId: string };

const main = (page: Page) => page.getByRole("main");

/**
 * Takes a new owner through Booking Admin's four-step setup (VAY-2451, with ONBOARDING_V2_ENABLED) as an
 * owner does: Welcome, "Your property", "Location & contact" (its Continue
 * creates the hotel), the first room's basics (photos skipped: the room is saved as it stands), "How guests
 * pay" and Finish setup. The first run then sets pay at the property, the Commission plan, the calendar,
 * guest rules and a placeholder price, and setup leaves for the dashboard. The placeholder can't be
 * published: the owner sets the real price in the PMS (`setRoomPriceInPms`), then publishes from the
 * dashboard (`publishFromDashboard`). `onPropertyCreated` runs as soon as the hotel exists.
 */
export async function completeFourStepSetup(
  page: Page,
  hotel: FirstRunHotel,
  onPropertyCreated: (propertyId: string) => void,
): Promise<FourStepSetupResult> {
  const propertyId = await test.step("enter the property, its address and contacts", async () => {
    await expect(heading(page, "Welcome to vayada")).toBeVisible();
    await page.getByRole("button", { name: "Start setup", exact: true }).click();

    await expect(heading(page, "Your property")).toBeVisible();
    await field(page, "Property name").fill(hotel.name);
    await page.getByRole("radio", { name: "Hotel", exact: true }).click();
    await proceed(page).click();

    await expect(heading(page, "Location & contact")).toBeVisible();
    // With a Google Maps key the address opens on its search; the smoke types the address.
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
    await field(page, "Reception email").fill(hotel.receptionEmail);
    // WhatsApp stays "Same as phone"; the social links stay empty.
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

  const roomTypeId = await test.step("add the first room's basics", async () => {
    await expect(heading(page, "Your first room type")).toBeVisible({ timeout: 45_000 });
    // "Set it up now" is the choice it opens with.
    await proceed(page).click();
    await expect(heading(page, "Room basics")).toBeVisible();
    await page.getByLabel("Room type name").fill(hotel.room.name);
    await page.getByLabel("Room size").fill("20");
    // The room starts as one room for 2 guests.
    for (let rooms = 1; rooms < hotel.room.numberOfRooms; rooms += 1)
      await page.getByRole("button", { name: "More rooms", exact: true }).click();
    for (let guests = 2; guests < hotel.room.maxGuests; guests += 1)
      await page.getByRole("button", { name: "More guests", exact: true }).click();
    for (let guests = 2; guests > hotel.room.maxGuests; guests -= 1)
      await page.getByRole("button", { name: "Fewer guests", exact: true }).click();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/pms/setup/properties/${propertyId}/room-types`,
      { timeout: 45_000 },
    );
    await proceed(page).click();
    const response = await saved;
    const body = await response.text();
    expect(response.ok(), `Creating the room returned ${response.status()}: ${body}`).toBe(true);
    // The room setup's create answers with the room type and its draft binding (`first-run-room-1`).
    const id = stringField(record(record(JSON.parse(body)).draftRoomBinding), "roomTypeId");
    // The photos part: skipped, which saves the room as it stands.
    await expect(heading(page, "Photos, description & location")).toBeVisible({ timeout: 45_000 });
    await page.getByRole("button", { name: "Skip for now", exact: true }).click();
    return id;
  });

  await test.step("pay at the property and finish setup", async () => {
    await expect(heading(page, "How guests pay")).toBeVisible({ timeout: 45_000 });
    const firstRun = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/hotel-setup/properties/${propertyId}/first-run`,
      { timeout: 120_000 },
    );
    await page.getByRole("button", { name: "Finish setup", exact: true }).click();
    const response = await firstRun;
    // Setup leaves for the dashboard as soon as the first run answers, which drops the response
    // body: it is read only when the run failed (and setup stays).
    if (!response.ok())
      throw new Error(
        `The first run returned ${response.status()}: ${await response.text().catch(() => "")}`,
      );
    // Setup leaves for the dashboard, which says setup is complete.
    await page.waitForURL(
      (url) => url.pathname === "/dashboard" && url.searchParams.get("setupFinished") === "1",
      { timeout: 45_000 },
    );
  });

  return { propertyId, roomTypeId };
}

/**
 * The owner's real price for the four-step setup's room, in the PMS (Rooms & Rates › the room › Prices) where
 * the dashboard's "Add rates" leads: the first run's placeholder (100) becomes the owner's price, saved with
 * the owner's declaration that it includes all mandatory taxes and fees. The page must be signed in to the PMS.
 */
export async function setRoomPriceInPms(
  page: Page,
  pmsOrigin: string,
  room: { roomTypeId: string; name: string; pricePerNight: string },
): Promise<void> {
  await test.step("set the room's real price in the PMS", async () => {
    await page.goto(`${pmsOrigin}/rooms/${room.roomTypeId}?tab=prices`);
    await expect(
      main(page).getByRole("heading", { name: "Prices and seasons", exact: true }).first(),
    ).toBeVisible({ timeout: 45_000 });
    // The simple card's normal price for the room's first rate.
    const price = main(page).getByLabel(`${room.name} Offer 1 Per room`);
    await expect(price).toHaveValue("100.00");
    await price.fill(room.pricePerNight);
    await main(page).getByRole("button", { name: "Save and publish" }).click();
    await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible({
      timeout: 45_000,
    });
  });
}

/**
 * Publishes the booking page from Booking Admin's dashboard, as the four-step setup's owner does once the
 * room has its real price: the booking page card's "Publish booking page" (which goes through the same
 * review), with its "Try again" and "Check again" while the review catches up. Returns the live page's link.
 */
export async function publishFromDashboard(
  page: Page,
  bookingAdminOrigin: string,
): Promise<string> {
  return test.step("publish the booking page from the dashboard", async () => {
    await page.goto(`${bookingAdminOrigin}/dashboard`);
    const card = page.getByRole("region", { name: "Your booking page" });
    const open = card.getByRole("link", { name: "Open booking page" });
    const publish = card.getByRole("button", { name: "Publish booking page", exact: true });
    const retry = card.getByRole("button", { name: "Try again", exact: true });
    const check = card.getByRole("button", { name: "Check again", exact: true });
    await expect(async () => {
      if (await open.isVisible()) return;
      if (await retry.isVisible()) await retry.click();
      else if ((await publish.isVisible()) && (await publish.isEnabled())) await publish.click();
      else if (await check.isVisible()) await check.click();
      await expect(open).toBeVisible({ timeout: 20_000 });
    }).toPass({ timeout: 180_000, intervals: [2_000, 5_000, 10_000] });
    const href = await open.getAttribute("href", { timeout: 10_000 });
    // Without a link the page is published but not served at its address yet (VAY-2193).
    if (!href) throw new Error("The dashboard shows no booking page link.");
    return href;
  });
}
