import { expect, test } from "@playwright/test";
import { completeFourStepSetup, publishFromDashboard } from "../next-stack-smoke/first-run";
import { submitAccountDetails } from "../next-stack-smoke/support";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  BOOKING_PUBLICATION_PATH,
  bookingPublicationReviewMock,
  fulfillPublication,
  publicationOperationMock,
} from "../support/bookingPublicationMocks";
import {
  FOUR_STEP_HOTEL as HOTEL,
  FOUR_STEP_PROPERTY_ID as propertyId,
  OLDER_HOTEL,
  fourStepSetupUrl,
  json,
  mockFourStepOwner as mockOwner,
  primeSetupBrowserState,
} from "../support/fourStepSetupMocks";
import { ROOM_OWNER_ROOM_TYPE_IDS, mockRoomOwnerApis } from "../support/roomOwnerMocks";

// VAY-2357, VAY-2451: the live next-stack smoke drives Booking Admin's four-step setup with these same
// helpers. Here they run against a mocked API, so a renamed label or button fails the PR instead of the next
// live run. With them: an older setup's hotel continuing in the four-step setup, and About you's save. The
// setup sits behind ONBOARDING_V2_ENABLED, set on PR Checks' first-run server.
test.skip(
  process.env.E2E_ONBOARDING_V2 !== "1",
  "needs a Booking Admin server with ONBOARDING_V2_ENABLED=true (run with E2E_ONBOARDING_V2=1)",
);

const BOOKING_URL = "https://hotel-alpenrose.next-booking.vayada.com";

test("the smoke's four-step helpers take a new owner from About you to Finish setup", async ({
  page,
  baseURL,
}) => {
  await primeSetupBrowserState(page, propertyId);
  const writes = await mockOwner(page, { newOwner: true });
  const owner = await mockRoomOwnerApis(page);
  await page.goto(fourStepSetupUrl(baseURL, "&returnTo=/dashboard"));

  await expect(
    submitAccountDetails(page, { firstName: "Harper", lastName: "Smoke" }, "+49 30 5550102"),
  ).resolves.toBe("first_run");
  const created: string[] = [];
  const result = await completeFourStepSetup(page, HOTEL, (id) => created.push(id));
  expect(result).toEqual({ propertyId, roomTypeId: ROOM_OWNER_ROOM_TYPE_IDS[0] });
  expect(created).toEqual([propertyId]);
  expect(writes.firstRun).toEqual({ guestPayment: "pay_at_property" });
  expect(writes.currency).toMatchObject({ currency: "EUR" });
  expect(writes.hotel).toMatchObject({
    displayName: HOTEL.name,
    contacts: expect.arrayContaining([
      expect.objectContaining({ channelType: "whatsapp", value: HOTEL.receptionPhone }),
    ]),
  });
  expect(owner.createdDraftIds).toEqual(["first-run-room-1"]);
});

test("the smoke publishes from the dashboard's booking page card and reads the live link", async ({
  page,
  baseURL,
}) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  let published = false;
  await page.route(BOOKING_PUBLICATION_PATH, async (route) => {
    if (route.request().method() === "POST") {
      published = true;
      return fulfillPublication(route, {
        json: publicationOperationMock(BOOKING_ADMIN_PROPERTY_ID),
      });
    }
    const review = await bookingPublicationReviewMock(
      BOOKING_ADMIN_PROPERTY_ID,
      published ? "online" : "ready",
    );
    return fulfillPublication(route, {
      json: { ...review, publishedUrl: published ? BOOKING_URL : null },
    });
  });
  const origin = new URL(baseURL!).origin;
  await expect(publishFromDashboard(page, origin)).resolves.toBe(BOOKING_URL);
  expect(published).toBe(true);
});

for (const [size, viewport] of [
  ["1440", { width: 1440, height: 900 }],
  ["390", { width: 390, height: 844 }],
] as const) {
  test(`an older setup's hotel without its address continues at Location & contact (${size})`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await primeSetupBrowserState(page, propertyId);
    await mockOwner(page, { profile: OLDER_HOTEL });
    await mockRoomOwnerApis(page);
    // The 7-step setup kept its room on this device.
    await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
      `vayada.quickSetup.v1.room.${propertyId}`,
      JSON.stringify({
        rooms: [{ name: "Garden Double", numberOfRooms: "3", maxGuests: "3", pricePerNight: "90" }],
        pricesIncludeMandatoryCharges: true,
        bed: "twin",
      }),
    ] as const);
    const setup = new URL(fourStepSetupUrl(baseURL, `&propertyId=${propertyId}`));
    await page.goto(setup.toString());
    await expect(page.getByRole("heading", { name: "Location & contact", level: 1 })).toBeVisible();
    await expect(page.getByText("Step 2 of 4").first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Instagram link" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    // Back to step 1, filled in from the hotel.
    await page.getByRole("button", { name: "Back", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Your property", level: 1 })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Property name", exact: true })).toHaveValue(
      HOTEL.name,
    );
  });
}

test("an older setup's room on this device fills the room step, and old links find their page", async ({
  page,
  baseURL,
}) => {
  await primeSetupBrowserState(page, propertyId);
  await mockOwner(page, {
    profile: {
      ...OLDER_HOTEL,
      location: {
        ...OLDER_HOTEL.location,
        streetAddress: HOTEL.streetAddress,
        postalCode: HOTEL.postalCode,
        timezone: "Europe/Berlin",
        latitude: 48.137,
        longitude: 11.575,
      },
    },
  });
  await mockRoomOwnerApis(page);
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    `vayada.quickSetup.v1.room.${propertyId}`,
    JSON.stringify({
      rooms: [{ name: "Garden Double", numberOfRooms: "3", maxGuests: "3", pricePerNight: "90" }],
      pricesIncludeMandatoryCharges: true,
      bed: "twin",
    }),
  ] as const);
  const setup = new URL(fourStepSetupUrl(baseURL, `&propertyId=${propertyId}`));
  await page.goto(setup.toString());
  await expect(page.getByRole("heading", { name: "Your first room type", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Room type name")).toHaveValue("Garden Double");
  await expect(page.getByText("2 twin beds")).toBeVisible();
  // "Fix in setup" for the address opens step 2 of the hotel.
  setup.searchParams.set("step", "present_hotel");
  setup.searchParams.set("focus", "location");
  await page.goto(setup.toString());
  await expect(page.getByRole("heading", { name: "Location & contact", level: 1 })).toBeVisible();
});

// VAY-2399: a change made while About you saved was never sent, and the step then left without a word.
// The fields are disabled while the save runs, as the button is; a failed save gives them back with every
// value, and focus returns to the field the owner was in.
test("About you can't be changed while its save runs, and a failed save keeps every value", async ({
  page,
  baseURL,
}) => {
  await primeSetupBrowserState(page, propertyId);
  const writes = await mockOwner(page, { newOwner: true });
  // A slow save, refused the first time: the account write waits until the test lets it go.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let refuse = true;
  const saves: unknown[] = [];
  await page.route(/\/auth\/profile$/, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    saves.push(route.request().postDataJSON());
    await held;
    if (!refuse) return route.fallback();
    return json(route, { message: "We couldn't save your details. Try again." }, 503);
  });
  await page.goto(fourStepSetupUrl(baseURL, "&returnTo=/dashboard"));

  const firstName = page.getByRole("textbox", { name: "First name", exact: true });
  const lastName = page.getByRole("textbox", { name: "Last name", exact: true });
  const phone = page.getByRole("textbox", { name: "Your phone", exact: true });
  await firstName.fill("Harper");
  await lastName.fill("Smoke");
  await phone.fill("+49 30 5550102");
  await lastName.press("Enter");
  await expect(firstName).toBeDisabled();
  await expect(phone).toBeDisabled();
  // The browser takes focus off the field as it is disabled; the step puts it back after a failure.
  await expect(lastName).not.toBeFocused();
  // Typing meanwhile changes nothing: it couldn't be part of this save.
  await firstName.click({ force: true });
  await page.keyboard.type(" Jr");
  release();
  await expect(
    page.getByRole("alert").filter({ hasText: "We couldn't save your details. Try again." }),
  ).toBeVisible();
  await expect(firstName).toBeEnabled();
  await expect(firstName).toHaveValue("Harper");
  await expect(lastName).toHaveValue("Smoke");
  // Focus is back in the field, so Enter tries again.
  await expect(lastName).toBeFocused();
  refuse = false;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Welcome to vayada", level: 1 })).toBeVisible();
  expect(saves).toHaveLength(2);
  expect(saves[1]).toEqual(saves[0]);
  expect(writes.account).toMatchObject({
    firstName: "Harper",
    lastName: "Smoke",
    phone: "+49 30 5550102",
  });
});
