import { expect, test } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_ROOM_ID,
  PMS_WEB_ROOM_TYPE_ID,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

const GARDEN_ROOM_TYPE_ID = "room_type_garden_studio";
const GARDEN_ROOM_ID = "room_201";
// VAY-2065: created through hotel setup on a property that has not published prices, so it
// carries neither a legacy rate nor a currency.
const LOFT_ROOM_TYPE_ID = "room_type_loft";
const LOFT_ROOM_ID = "room_301";
const manualBookingPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/manual-bookings`;

function plan(ratePlanId: string, name: string, rateType: string, amountDecimal: string) {
  return {
    ratePlanId,
    pricingContractVersion: "pricing.v2",
    name,
    rateType,
    baseRate: { amountDecimal, currency: "EUR" },
    active: true,
  };
}

// VAY-1422: the published offers are the rate plans; Flexible is preferred over Non-refundable
// regardless of server order, children need ages before an offer is priced, a room type without
// published offers falls back to Custom, and nationality submits as an ISO code.
// VAY-2065: a setup-created room type without a currency sends its custom rate without one and
// previews and saves in the currency the server answers with.
test("defaults the rate plan, falls back to Custom, and submits nationality as ISO code", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "test-owner",
        roleKey: "hotel_owner",
        permissions: ["pms.operations.read", "pms.operations.manage"],
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [
          {
            ...pmsWebRoomType,
            ratePlans: [
              plan("nr-rate", "Non-refundable", "non_refundable", "160.00"),
              plan("flexible-rate", "Flexible", "flexible", "180.00"),
            ],
          },
          {
            ...pmsWebRoomType,
            roomTypeId: GARDEN_ROOM_TYPE_ID,
            name: "Garden Studio",
            ratePlans: [],
            sortOrder: 1,
          },
          {
            ...pmsWebRoomType,
            roomTypeId: LOFT_ROOM_TYPE_ID,
            name: "Loft",
            baseRate: { amountDecimal: null, currency: null },
            ratePlans: [],
            sortOrder: 2,
          },
        ],
        sourceFreshness: {},
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [
          {
            roomId: PMS_WEB_ROOM_ID,
            roomTypeId: PMS_WEB_ROOM_TYPE_ID,
            roomNumber: "101",
            floor: "1",
            status: "available",
            sortOrder: 0,
            metadata: {},
          },
          {
            roomId: GARDEN_ROOM_ID,
            roomTypeId: GARDEN_ROOM_TYPE_ID,
            roomNumber: "201",
            floor: "2",
            status: "available",
            sortOrder: 1,
            metadata: {},
          },
          {
            roomId: LOFT_ROOM_ID,
            roomTypeId: LOFT_ROOM_TYPE_ID,
            roomNumber: "301",
            floor: "3",
            status: "available",
            sortOrder: 2,
            metadata: {},
          },
        ],
        sourceFreshness: {},
      },
    }),
  );
  await page.route(`${manualBookingPath}/addons`, (route) =>
    route.fulfill({ json: { contractVersion: "pms-manual-booking.v1", addOns: [] } }),
  );
  await page.route(`${manualBookingPath}/capabilities`, (route) =>
    route.fulfill({
      json: { contractVersion: "pms-manual-booking.v1", canRecordPaidPayment: false },
    }),
  );
  type PreviewStay = {
    position: number;
    roomId: string;
    ratePlanId: string | null;
    checkIn: string;
    checkOut: string;
    childAgesAtCheckIn?: number[];
    pricing: { kind: string; nightlyAmount?: { amountDecimal: string; currency?: string } };
  };
  const previewBodies: Array<{ stays: PreviewStay[] }> = [];
  await page.route(`${manualBookingPath}/preview`, (route) => {
    const body = route.request().postDataJSON();
    previewBodies.push(body);
    // The property prices in EUR: a custom rate sent without a currency is answered in it.
    const currency = "EUR";
    const stays = body.stays.map((stay: PreviewStay) => {
      const nights = Math.round(
        (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86_400_000,
      );
      const custom = stay.pricing.kind === "custom";
      const nightly = custom ? Number(stay.pricing.nightlyAmount!.amountDecimal) : 180;
      const money = (amount: number) => ({ amountDecimal: amount.toFixed(2), currency });
      return {
        position: stay.position,
        roomId: stay.roomId,
        ratePlanId: stay.ratePlanId,
        nightly: [],
        standardTotal: custom ? null : money(180 * nights),
        appliedTotal: money(nightly * nights),
      };
    });
    const total = stays.reduce(
      (sum: number, stay: { appliedTotal: { amountDecimal: string } }) =>
        sum + Number(stay.appliedTotal.amountDecimal),
      0,
    );
    return route.fulfill({
      json: {
        contractVersion: "pms-manual-booking.v1",
        currency,
        stays,
        addOns: [],
        grandTotal: { amountDecimal: total.toFixed(2), currency },
      },
    });
  });
  let createBody: Record<string, unknown> | null = null;
  await page.route(manualBookingPath, (route) => {
    createBody = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        contractVersion: "pms-manual-booking.v1",
        outcome: "created",
        commandId: createBody!["commandId"],
        idempotencyKey: createBody!["idempotencyKey"],
        guestBookingId: "guest_booking_new",
        bookingReference: "VAY-NEW",
        bookingChannel: "direct",
        directSource: createBody!["directSource"],
        stayCount: 1,
        checkIn: "2026-09-10",
        checkOut: "2026-09-12",
        total: { amountDecimal: "300.00", currency: "EUR" },
        balance: { amountDecimal: "300.00", currency: "EUR" },
        paymentStatus: "unpaid",
        paymentEvidenceId: null,
        rearrangedBookingCount: 0,
        sideEffects: ["calendar_refresh"],
      },
    });
  });

  await page.goto("/calendar");
  await page
    .getByRole("button", { name: /new booking/i })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "New booking" });
  const ratePlan = dialog.getByLabel("Room 1 rate plan");
  const createBooking = dialog.getByRole("button", { name: "Create booking" });

  // Flexible wins over the Non-refundable plan listed first by the server.
  await expect(ratePlan).toHaveValue("flexible-rate");
  await expect(ratePlan.locator("option")).toHaveText([
    "Non-refundable",
    "Flexible",
    "Custom rate",
  ]);
  await dialog.getByLabel("Room 1 check-in").fill("2026-09-10");
  await dialog.getByLabel("Room 1 check-out").fill("2026-09-12");
  await expect(dialog.getByText("Standard: €360")).toBeVisible();
  await expect(dialog.getByText("Applied: €360")).toBeVisible();

  // Offers take the published price, so the nightly field is Custom-only, and children are
  // priced by age: the stay is sent once every age is entered.
  await expect(dialog.getByLabel("Room 1 nightly rate")).toHaveCount(0);
  await dialog.getByLabel("Room 1 children").fill("1");
  const childAge = dialog.getByLabel("Age at check-in, room 1, child 1");
  await expect(childAge).toBeVisible();
  await childAge.fill("6");
  await expect.poll(() => previewBodies.at(-1)?.stays[0]?.childAgesAtCheckIn).toEqual([6]);
  await dialog.getByLabel("Room 1 children").fill("0");
  await expect(childAge).toHaveCount(0);

  // A room type without configured plans falls back to Custom instead of blocking.
  await dialog.getByLabel("Room 1 room").selectOption(GARDEN_ROOM_ID);
  await expect(ratePlan).toHaveValue("custom");
  await expect(ratePlan.locator("option")).toHaveText(["Custom rate"]);
  await expect(dialog.getByText("No rate plan is published for this room type.")).toBeVisible();
  await expect(page.getByText("Enter a custom nightly rate to calculate the total")).toBeVisible();
  await expect(createBooking).toBeDisabled();
  await dialog.getByLabel("Room 1 nightly rate").fill("150");
  await expect(dialog.getByText("Custom: €300")).toBeVisible();
  await expect(dialog.getByText("Standard:")).toHaveCount(0);
  await expect(page.getByText("Total €300")).toBeVisible();
  await expect(createBooking).toBeEnabled();
  // The legacy room type still sends its own currency with the custom rate.
  expect(previewBodies.at(-1)?.stays[0]?.pricing.nightlyAmount).toEqual({
    amountDecimal: "150.00",
    currency: "EUR",
  });

  // A setup-created room type has no currency yet: the custom rate goes without one and the
  // total shows the property currency the server answers with (VAY-2065).
  await dialog.getByLabel("Room 1 room").selectOption(LOFT_ROOM_ID);
  await expect(ratePlan).toHaveValue("custom");
  await dialog.getByLabel("Room 1 nightly rate").fill("150");
  await expect(page.getByText("Total €300")).toBeVisible();
  await expect(createBooking).toBeEnabled();
  expect(previewBodies.at(-1)?.stays[0]?.pricing.nightlyAmount).toEqual({
    amountDecimal: "150.00",
  });

  // Nationality and the phone code share one searchable country picker with SVG flags; the
  // nationality is stored as its ISO alpha-2 code (VAY-2417).
  const nationality = dialog.getByRole("button", { name: "Nationality", exact: true });
  await expect(nationality).toHaveText("Choose a country");
  await nationality.click();
  const nationalitySearch = dialog.getByRole("combobox", {
    name: "Search country, nationality or code",
  });
  await expect(nationalitySearch).toBeFocused();
  // Esc closes the list, not the booking modal.
  await nationalitySearch.press("Escape");
  await expect(nationalitySearch).toBeHidden();
  await expect(dialog).toBeVisible();
  await nationality.click();
  await nationalitySearch.fill("German");
  const firstMatch = dialog.getByRole("listbox").getByRole("option").first();
  await expect(firstMatch).toContainText("Germany");
  await expect(firstMatch.locator(".fi.fi-de")).toBeVisible();
  await nationalitySearch.press("Enter");
  await expect(nationality).toContainText("Germany");
  await dialog.getByRole("textbox", { name: "First Name *" }).fill("Ada");
  await dialog.getByRole("textbox", { name: "Last Name *" }).fill("Lovelace");
  await dialog.getByRole("textbox", { name: "Email *" }).fill("ada@example.com");

  // Phone dial code defaults to the property's country (DE in the shared profile mock);
  // a pasted international number switches the code, and the request carries E.164.
  const dialCode = dialog.getByRole("button", { name: "Phone country code", exact: true });
  await expect(dialCode).toHaveAttribute("value", "DE");
  await expect(dialCode).toContainText("+49");
  const phone = dialog.getByRole("textbox", { name: "Phone" });
  await phone.fill("+62 812 3456 7890");
  await phone.blur();
  await expect(dialCode).toHaveAttribute("value", "ID");
  await expect(phone).toHaveValue("0812-3456-7890");
  await dialCode.click();
  await dialog.getByRole("combobox", { name: "Search country or dial code" }).fill("+49");
  await dialog.getByRole("combobox", { name: "Search country or dial code" }).press("Enter");
  await expect(dialCode).toHaveAttribute("value", "DE");
  await phone.fill("089 1234567");
  await expect(dialog.getByText(/^Saved as \+49 /)).toBeVisible();

  // One card per guest from the room's adults and children; other guests give a name and
  // nationality, and "Same as Guest 1" copies the lead's (VAY-2417).
  await expect(dialog.getByLabel("Guest 2 first name")).toHaveCount(0);
  await dialog.getByLabel("Room 1 adults").fill("2");
  await dialog.getByLabel("Guest 2 first name").fill("Grace");
  await dialog.getByLabel("Guest 2 last name").fill("Hopper");
  await dialog.getByRole("button", { name: "Same as Guest 1" }).click();
  await expect(
    dialog.getByRole("button", { name: "Guest 2 nationality", exact: true }),
  ).toContainText("Germany");
  await expect(page.getByText("Total €300")).toBeVisible();
  await createBooking.click();
  await expect.poll(() => createBody).not.toBeNull();
  expect(createBody).toMatchObject({
    guest: {
      firstName: "Ada",
      lastName: "Lovelace",
      countryCode: "DE",
      phoneE164: "+49891234567",
    },
    additionalGuests: [
      { firstName: "Grace", lastName: "Hopper", email: null, phoneE164: null, countryCode: "DE" },
    ],
    stays: [
      {
        roomId: LOFT_ROOM_ID,
        ratePlanId: null,
        pricing: { kind: "custom", nightlyAmount: { amountDecimal: "150.00" } },
      },
    ],
  });
  expect(createBody!["stays"]).toHaveLength(1);
  expect(
    (createBody!["stays"] as Array<{ pricing: { nightlyAmount: object } }>)[0]!.pricing
      .nightlyAmount,
  ).not.toHaveProperty("currency");
});
