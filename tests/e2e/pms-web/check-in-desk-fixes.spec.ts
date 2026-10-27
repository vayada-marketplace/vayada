import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2373 bug fixes on today's check-in page and arrival popup (worker L P0, 2026-10-26).
const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;

const grace = {
  guestId: "guest_grace",
  guestBookingId: PMS_WEB_RESERVATION_ID,
  displayName: "Grace Hopper",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  phone: null,
  countryCode: "US",
  countryCodeRaw: null,
  countryCodeReviewRequired: false,
};

async function mockReservation(page: Page, reservation: () => Record<string, unknown>) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`${base}/notes`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/additional-guests`, (route) =>
    route.fulfill({ json: { items: [grace] } }),
  );
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  const template = { steps: [], updatedAt: null, updatedByUserId: null };
  for (const path of ["check-in-checklist", "check-out-inspection"])
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/${path}`, (route) =>
      route.fulfill({ json: { template } }),
    );
  await page.route(base, (route) => route.fulfill({ json: { item: reservation() } }));
}

/** The 4-step check-in (VAY-2373): jump to a step from the step bar. */
async function openCheckinStep(page: Page, title: string) {
  await page
    .getByRole("navigation", { name: "Check-in steps" })
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .click();
}

test("records a pay-at-hotel payment at check-in and shows the special request", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let paid = false;
  let countryCode = "AT";
  const reservation = () => ({
    ...pmsWebReservation,
    primaryGuest: {
      ...pmsWebReservation.primaryGuest,
      countryCode,
      specialRequests: "Late arrival around 11 pm, please leave the key at the bar.",
    },
    pricing: {
      totalAmount: { amountDecimal: "240.00", currency: "EUR" },
      balanceAmount: { amountDecimal: paid ? "0.00" : "240.00", currency: "EUR" },
    },
    payment: {
      method: "pay_at_property",
      expectedMethod: "pay_at_property",
      status: paid ? "paid" : "unpaid",
    },
  });
  await mockReservation(page, reservation);
  await page.route(`${base}/mark-paid`, (route) => {
    // VAY-2374 D2: the desk records how it took the money.
    expect(route.request().postDataJSON()).toMatchObject({
      commandId: expect.any(String),
      settlementMethod: "cash",
    });
    paid = true;
    return route.fulfill({ json: { reservation: reservation() } });
  });
  await page.route(`${base}/primary-guest/nationality`, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ countryCode: "NL" });
    countryCode = "NL";
    return route.fulfill({
      json: { primaryGuest: { ...pmsWebReservation.primaryGuest, countryCode: "NL" } },
    });
  });

  const registrations: Record<string, unknown>[] = [];
  await page.route(`${base}/guest-registrations/*`, (route) => {
    registrations.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        guestId: "guest_ada",
        role: "booker",
        ...route.request().postDataJSON(),
        filledFields: [],
        updatedAt: null,
      },
    });
  });
  await page.route(`${base}/guest-registrations`, (route) =>
    route.fulfill({
      json: {
        guestBookingId: PMS_WEB_RESERVATION_ID,
        canReadIdentity: true,
        guests: [
          {
            guestId: "guest_ada",
            role: "booker",
            assignmentId: null,
            dateOfBirth: null,
            documentType: null,
            documentNumber: null,
            gender: null,
            staffNotes: null,
            filledFields: [],
            updatedAt: null,
          },
        ],
      },
    }),
  );

  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  const main = page.locator("main").first();
  await expect(
    main.getByText("Late arrival around 11 pm, please leave the key at the bar."),
  ).toBeVisible();
  // Settings → Check-in asks staff to confirm they read it before going on.
  const proceed = main.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await main.getByRole("checkbox", { name: "I have read the request" }).check();
  await proceed.click();

  // The booker's contact comes from the booking; the nationality can be corrected here.
  await main.getByRole("button", { name: /^Complete Ada Lovelace/ }).click();
  const bookerNationality = main.getByRole("combobox", { name: /Nationality/ });
  await expect(bookerNationality).toHaveValue("Austria");
  await expect(bookerNationality).toBeEnabled();
  await expect(main.getByRole("textbox", { name: /First name/ })).toBeDisabled();
  await bookerNationality.fill("Netherlands");
  await main.getByRole("button", { name: "Save guest" }).click();
  await expect.poll(() => countryCode).toBe("NL");
  await expect.poll(() => registrations.length).toBe(1);

  await openCheckinStep(page, "Add-ons & payment");
  await expect(main.getByText("Due now").locator("..")).toContainText("€240");
  await main.getByRole("radio", { name: /Collect now/ }).click();
  await main.getByRole("button", { name: "Cash", exact: true }).click();
  await main.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => paid).toBe(true);
  await expect(main.getByText("Step 4 of 4")).toBeVisible();
  await expect(main.getByText(/€240(\.00)? · Cash, recorded/)).toBeVisible();
  await assertHealthy();
});

test("shows and records the rest of a card deposit at check-in", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let paid = false;
  const reservation = () => ({
    ...pmsWebReservation,
    pricing: {
      totalAmount: { amountDecimal: "240.00", currency: "EUR" },
      balanceAmount: { amountDecimal: paid ? "0.00" : "168.00", currency: "EUR" },
    },
    payment: { method: "card", expectedMethod: "card", status: paid ? "paid" : "partially_paid" },
  });
  await mockReservation(page, reservation);
  await page.route(`${base}/mark-paid`, (route) => {
    paid = true;
    return route.fulfill({ json: { reservation: reservation() } });
  });

  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await openCheckinStep(page, "Add-ons & payment");
  const main = page.locator("main").first();
  // The card deposit already paid €72; the rest is due at the desk.
  await expect(
    main.locator("dl").getByText("Already paid", { exact: true }).locator(".."),
  ).toContainText("€72");
  await expect(main.getByText("Due now").locator("..")).toContainText("€168");
  await main.getByRole("radio", { name: /Collect now/ }).click();
  await main.getByRole("button", { name: "Card · own terminal", exact: true }).click();
  await main.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => paid).toBe(true);
  await expect(main.getByText(/€168(\.00)? · Card · own terminal, recorded/)).toBeVisible();
  await assertHealthy();
});

test("offers no payment record for a cancelled card-deposit stay", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockReservation(page, () => ({
    ...pmsWebReservation,
    status: "cancelled",
    pricing: {
      totalAmount: { amountDecimal: "240.00", currency: "EUR" },
      balanceAmount: { amountDecimal: "168.00", currency: "EUR" },
    },
    payment: { method: "card", expectedMethod: "card", status: "partially_paid" },
  }));

  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await openCheckinStep(page, "Add-ons & payment");
  // Not a balance the desk can take: nothing to choose, nothing recorded.
  await expect(page.getByText("Settled outside the desk").locator("..")).toContainText("€168");
  await expect(page.getByText("Nothing to collect at the desk.")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await assertHealthy();
});

test("offers no payment record for an OTA-collected stay", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockReservation(page, () => ({
    ...pmsWebReservation,
    source: "channel",
    payment: { method: null, expectedMethod: "unknown", status: "unpaid" },
  }));

  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await expect(page.getByRole("heading", { name: /Ada Lovelace/ }).first()).toBeVisible();
  await openCheckinStep(page, "Add-ons & payment");
  await expect(page.getByRole("heading", { name: "Add-ons & payment" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await assertHealthy();
});

test.describe("arrival popup", () => {
  test.use({ timezoneId: "Europe/Vienna" });

  test("shows the balance still owed and how many guests are registered", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.clock.install({ time: new Date("2026-08-15T08:00:00Z") });
    // A card deposit paid €72 of €240 when booking; three guests, two of them named.
    const arrival = {
      ...pmsWebReservation,
      stay: { ...pmsWebReservation.stay, adults: 3 },
      pricing: {
        totalAmount: { amountDecimal: "240.00", currency: "EUR" },
        balanceAmount: { amountDecimal: "168.00", currency: "EUR" },
      },
      payment: { method: "card", expectedMethod: "card", status: "partially_paid" },
    };
    await mockReservation(page, () => arrival);
    // Ada and Grace have their ID and date of birth recorded (VAY-2373); the third adult is unnamed.
    const documented = ["documentType", "documentNumber", "dateOfBirth"];
    await page.route(`${base}/guest-registrations`, (route) =>
      route.fulfill({
        json: {
          guestBookingId: PMS_WEB_RESERVATION_ID,
          canReadIdentity: true,
          guests: [
            { guestId: "guest_ada", role: "booker", filledFields: documented },
            { guestId: grace.guestId, role: "additional_guest", filledFields: documented },
          ].map((guest) => ({
            ...guest,
            assignmentId: null,
            dateOfBirth: null,
            documentType: null,
            documentNumber: null,
            gender: null,
            staffNotes: null,
            updatedAt: null,
          })),
        },
      }),
    );
    const reservations = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
    await page.unroute(reservations);
    await page.route(reservations, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [arrival],
          pagination: { total: 1, limit: 500, offset: 0 },
          sourceFreshness: {},
        },
      }),
    );

    await page.goto("/dashboard");
    await page
      .locator('section[aria-labelledby="arrivals-heading"]')
      .getByRole("button", { name: /Ada Lovelace/ })
      .click();
    const popup = page.getByRole("dialog");
    await expect(popup.getByText("2 of 3 guests registered")).toBeVisible();
    await expect(popup.getByText("Guest 3 has no details yet")).toBeVisible();
    await expect(popup.getByText(/€168(\.00)? due/)).toBeVisible();
    await expect(popup.getByText(/Card · €72(\.00)? paid so far/)).toBeVisible();
    await expect(popup.getByText(/€240/)).toHaveCount(0);
    await assertHealthy();
  });
});

test("records a desk charge in the booking's currency", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const charges: Record<string, unknown>[] = [];
  await mockReservation(page, () => ({
    ...pmsWebReservation,
    status: "checked_in",
    checkin: { completedAt: "2026-08-15T14:00:00.000Z", pendingFlags: [] },
    pricing: {
      totalAmount: { amountDecimal: "48000.00", currency: "LKR" },
      balanceAmount: { amountDecimal: "0.00", currency: "LKR" },
    },
    payment: { method: "pay_at_property", expectedMethod: "pay_at_property", status: "paid" },
  }));
  await page.route(`${base}/checkout-charges`, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: [] } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    charges.push(body);
    const amount = { amountDecimal: String(body.amountDecimal), currency: String(body.currency) };
    return route.fulfill({
      json: {
        charge: {
          chargeId: "charge_minibar",
          label: body.label,
          amount,
          originalAmount: amount,
          status: "pending",
          createdAt: "2026-08-16T10:00:00.000Z",
          settledAt: null,
          waivedAt: null,
        },
      },
    });
  });

  await page.goto(`/check-out/${PMS_WEB_RESERVATION_ID}`);
  await page.getByPlaceholder("Charge label").fill("Minibar");
  await page.getByPlaceholder("Amount").fill("1500");
  await page.getByRole("button", { name: "Add charge" }).click();
  await expect.poll(() => charges.length).toBe(1);
  expect(charges[0]).toMatchObject({ label: "Minibar", amountDecimal: "1500.00", currency: "LKR" });
  await assertHealthy();
});
