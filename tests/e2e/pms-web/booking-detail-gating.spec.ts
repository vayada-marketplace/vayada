import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

test("hydrates the selected property on direct booking navigation without a reload", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await page.addInitScript(() => {
    window.localStorage.removeItem("selectedHotelId");
    window.localStorage.removeItem("selectedSharedPropertyId");
  });
  await mockPmsWebTargetRoutes(page);

  let releaseDiscovery!: () => void;
  const discoveryGate = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  let statusRequests = 0;
  await page.route("**/api/hotel-setup/status**", async (route) => {
    statusRequests += 1;
    if (statusRequests > 1) await discoveryGate;
    await route.fulfill({
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "pms",
        organizationId: "org_pms_owner",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: PMS_WEB_PROPERTY_ID,
        propertyDisplayName: "Alpenrose Munich",
      }),
    });
  });
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) => route.fulfill({ json: { item: pmsWebReservation } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/change-request`,
    (route) => route.fulfill({ json: null }),
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(page.getByText("No properties", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
  releaseDiscovery();
  await expect(page.getByRole("button", { name: "Alpenrose Munich" })).toBeVisible();
  const messageGuest = page.getByRole("link", { name: "Message guest" });
  await expect(messageGuest).toBeVisible();
  await expect(messageGuest).toHaveAttribute(
    "href",
    `/inbox?booking=${encodeURIComponent(PMS_WEB_RESERVATION_ID)}`,
  );
  await expect(page).toHaveURL(new RegExp(`/bookings/${PMS_WEB_RESERVATION_ID}$`));
  await assertHealthy();
});

test("shows the exact connected-account payment breakdown to the host", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let vayadaCommission = "5.00";
  let netPayout = "91.80";
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) =>
      route.fulfill({
        json: {
          item: {
            ...pmsWebReservation,
            pricing: {
              totalAmount: { amountDecimal: "100.00", currency: "EUR" },
              balanceAmount: { amountDecimal: "0.00", currency: "EUR" },
            },
            payment: {
              method: "card",
              expectedMethod: "manual_card",
              status: "paid",
              breakdown: {
                grossAmount: { amountDecimal: "100.00", currency: "EUR" },
                stripeFee: { amountDecimal: "3.20", currency: "EUR" },
                vayadaCommission: { amountDecimal: vayadaCommission, currency: "EUR" },
                netPayout: { amountDecimal: netPayout, currency: "EUR" },
              },
            },
          },
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/change-request`,
    (route) => route.fulfill({ json: null }),
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  await expect(page.getByText("Gross amount")).toBeVisible();
  await expect(page.getByText("Stripe fee")).toBeVisible();
  await expect(page.getByText("vayada commission", { exact: true })).toBeVisible();
  await expect(page.getByText("Net payout")).toBeVisible();
  await expect(page.getByText("€91.80")).toBeVisible();
  await expect(page.getByText(/Stripe processing fees may not be returned/i)).toBeVisible();

  vayadaCommission = "0.00";
  netPayout = "96.80";
  await page.reload();
  await expect(page.getByText("Gross amount")).toBeVisible();
  await expect(page.getByText("vayada commission", { exact: true })).toHaveCount(0);
  await expect(page.getByText("€96.80")).toBeVisible();
  await assertHealthy();
});

test("gates legacy booking writes while keeping supported hotel actions active", async ({
  page,
}, testInfo) => {
  let assertHealthy = watchPageHealth(page, testInfo);
  let approvals = 0;
  let noteCreates = 0;
  let noteUpdates = 0;
  let createdGuest: Record<string, unknown> | null = null;
  let nationalityCorrections = 0;
  let rejectNationalityCorrection = true;

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);

  const changeRequest = {
    id: "change_ada",
    bookingId: PMS_WEB_RESERVATION_ID,
    status: "pending",
    oldCheckIn: "2026-08-15",
    oldCheckOut: "2026-08-17",
    oldAddonIds: [],
    oldAddonQuantities: {},
    oldAddonDates: {},
    oldTotal: 360,
    requestedCheckIn: "2026-08-16",
    requestedCheckOut: "2026-08-18",
    requestedAddonIds: [],
    requestedAddonQuantities: {},
    requestedAddonDates: {},
    requestedAddonNames: [],
    newTotal: 360,
    priceDifference: 0,
    currency: "EUR",
    declineReason: null,
    decidedAt: null,
    createdAt: "2026-08-02T10:00:00.000Z",
  };

  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) =>
      route.fulfill({
        json: {
          item: {
            ...pmsWebReservation,
            primaryGuest: nationalityCorrections
              ? { ...pmsWebReservation.primaryGuest, countryCode: "NL" }
              : {
                  ...pmsWebReservation.primaryGuest,
                  countryCode: null,
                  countryCodeRaw: "Holland",
                  countryCodeReviewRequired: true,
                },
          },
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/primary-guest/nationality`,
    (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ countryCode: "NL" });
      expect(body.commandId).toEqual(expect.any(String));
      expect(body.idempotencyKey).toEqual(expect.any(String));
      nationalityCorrections += 1;
      if (rejectNationalityCorrection) {
        return route.fulfill({ status: 500, json: { message: "Correction unavailable" } });
      }
      return route.fulfill({
        json: {
          primaryGuest: {
            ...pmsWebReservation.primaryGuest,
            countryCode: "NL",
            countryCodeRaw: null,
            countryCodeReviewRequired: false,
          },
        },
      });
    },
  );
  const originalNote = {
    noteId: "f6855900-0000-4000-8000-000000000001",
    body: "Guest prefers a quiet room.",
    authorUserId: "user_original_author",
    authorDisplayName: "Original Author",
    createdAt: "2026-08-01T10:00:00.000Z",
    auditMetadata: {
      editedByUserId: null,
      editedByDisplayName: null,
      editedAt: null,
    },
  };
  const secondNote = {
    ...originalNote,
    noteId: "f6855900-0000-4000-8000-000000000003",
    body: "Prepare the extra pillow.",
  };
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes**`,
    async (route) => {
      const method = route.request().method();
      if (method === "PATCH") {
        noteUpdates += 1;
        if (noteUpdates === 1) {
          return route.fulfill({ status: 500, json: { detail: "Temporary note failure" } });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return route.fulfill({
          json: {
            note: {
              ...originalNote,
              body: "Guest prefers a quiet room away from the lift.",
              auditMetadata: {
                editedByUserId: "user_pms_owner",
                editedByDisplayName: "PMS Owner",
                editedAt: "2026-08-13T18:00:00.000Z",
              },
            },
          },
        });
      }
      if (method === "POST") {
        noteCreates += 1;
        await new Promise((resolve) => setTimeout(resolve, 500));
        return route.fulfill({
          json: {
            note: {
              ...originalNote,
              noteId: "f6855900-0000-4000-8000-000000000002",
              body: "Late arrival confirmed.",
            },
          },
        });
      }
      return route.fulfill({ json: { items: [originalNote, secondNote] } });
    },
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests`,
    (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { guest: Record<string, unknown> };
        createdGuest = body.guest;
        return route.fulfill({
          json: {
            additionalGuest: {
              guestId: "guest_grace",
              guestBookingId: PMS_WEB_RESERVATION_ID,
              displayName: "Grace Hopper",
              firstName: "Grace",
              lastName: "Hopper",
              email: null,
              phone: null,
              countryCode: null,
            },
          },
        });
      }
      return route.fulfill({ json: { items: [] } });
    },
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/change-request**`,
    (route) => {
      if (route.request().url().endsWith("/accept")) {
        approvals += 1;
        return route.fulfill({ json: { ...changeRequest, status: "accepted" } });
      }
      return route.fulfill({ json: changeRequest });
    },
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  // Only manual stays keep the (disabled) legacy modify button; direct stays use host actions.
  await expect(page.getByRole("button", { name: /modify booking/i })).toHaveCount(0);
  // The booker is edited through their guest record (VAY-2420, the next test).
  await expect(page.getByRole("button", { name: "Edit booker" })).toBeEnabled();
  await expect(page.getByText("Needs review")).toBeVisible();
  await expect(page.getByText(/Imported value: Holland/)).toBeVisible();
  await page.getByRole("button", { name: "Correct nationality" }).click();
  await page.getByRole("combobox", { name: "Nationality" }).fill("Netherlands");
  await page.getByRole("button", { name: "Save nationality" }).click();
  await expect.poll(() => nationalityCorrections).toBe(1);
  const nationalityError = page.locator('p[role="alert"]');
  await expect(nationalityError).toHaveText("Correction unavailable");
  assertHealthy = watchPageHealth(page, testInfo);
  rejectNationalityCorrection = false;
  await page.getByRole("button", { name: "Save nationality" }).click();
  await expect.poll(() => nationalityCorrections).toBe(2);
  await expect(page.getByText("Netherlands", { exact: true })).toBeVisible();
  await expect(nationalityError).toHaveCount(0);
  await expect(page.getByText("Needs review")).toHaveCount(0);
  // Like modify, the legacy cancel button is manual-only (VAY-1279); direct stays use host actions.
  await expect(page.getByRole("button", { name: "Cancel Booking", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit stay dates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel booking", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Check in guest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add note" })).toBeEnabled();
  await expect(page.getByText("Guest prefers a quiet room.")).toBeVisible();
  await assertHealthy();
  await page.getByRole("button", { name: "Edit note" }).first().click();
  await page.getByLabel("Edit note text").fill("Guest prefers a quiet room away from the lift.");
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect(page.getByText("Temporary note failure")).toBeVisible();
  assertHealthy = watchPageHealth(page, testInfo);
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect(page.getByText("Temporary note failure")).toHaveCount(0);
  await expect(page.getByLabel("Edit note text")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit note" }).nth(1)).toBeDisabled();
  await expect.poll(() => noteUpdates).toBe(2);
  await expect(page.getByText(/Edited by PMS Owner/)).toBeVisible();
  await expect(page.getByText(/Original Author/).first()).toBeVisible();
  await page.getByRole("button", { name: "Add note" }).click();
  await page.getByPlaceholder(/Notes are only visible/).fill("Late arrival confirmed.");
  await page.getByRole("button", { name: "Save note" }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByPlaceholder(/Notes are only visible/)).toBeDisabled();
  await expect.poll(() => noteCreates).toBe(1);
  await expect(page.getByText("Late arrival confirmed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add guest" })).toBeEnabled();
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(page.getByLabel("First name")).toBeEditable();
  await expect(page.getByLabel("Last name")).toBeEditable();
  await expect(page.getByLabel("Gender")).toHaveCount(0);
  await expect(page.getByLabel("Date of birth")).toHaveCount(0);
  await expect(page.getByLabel(/passport/i)).toHaveCount(0);
  await page.getByLabel("First name").fill("Grace");
  await page.getByLabel("Last name").fill("Hopper");
  await page.getByRole("combobox", { name: "Nationality" }).fill("Netherlands");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => createdGuest).not.toBeNull();
  expect(createdGuest).toMatchObject({
    firstName: "Grace",
    lastName: "Hopper",
    countryCode: "NL",
  });
  expect(createdGuest).not.toHaveProperty("gender");
  expect(createdGuest).not.toHaveProperty("dateOfBirth");
  expect(createdGuest).not.toHaveProperty("passportNumber");

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("button", { name: /resend confirmation email/i })).toBeEnabled();

  await expect(page.getByRole("button", { name: "Approve Change" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Decline Change" })).toBeEnabled();
  await page.getByRole("button", { name: "Approve Change" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => approvals).toBe(1);
  await expect(page.getByText(/last change request was approved/i)).toBeVisible();

  await assertHealthy();
});

test("edits the booker's name and contact through their guest record (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const reservationPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  // Booked as "Ada Augusta" + "Lovelace": the reservation read only has the joined name.
  await page.route(reservationPath, (route) =>
    route.fulfill({
      json: {
        item: {
          ...pmsWebReservation,
          primaryGuest: { ...pmsWebReservation.primaryGuest, displayName: "Ada Augusta Lovelace" },
        },
      },
    }),
  );
  for (const path of ["notes", "additional-guests"])
    await page.route(`${reservationPath}/${path}`, (route) =>
      route.fulfill({ json: { items: [] } }),
    );
  await page.route(`${reservationPath}/change-request`, (route) => route.fulfill({ json: null }));
  const guestProfileId = "f6855a00-0000-4000-8000-000000000001";
  await page.route(`${reservationPath}/guest-profiles`, (route) =>
    route.fulfill({
      json: {
        guestBookingId: PMS_WEB_RESERVATION_ID,
        guests: [
          {
            bookingGuestId: "guest_ada",
            role: "booker",
            firstName: "Ada Augusta",
            lastName: "Lovelace",
            guestProfileId,
            reservations: 2,
            notes: [],
          },
        ],
      },
    }),
  );
  const edits: unknown[] = [];
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/guests/${guestProfileId}`,
    (route) => {
      edits.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    },
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await page.getByRole("button", { name: "Edit booker" }).click();
  const firstName = page.getByRole("textbox", { name: "First Name" });
  await expect(firstName).toHaveValue("Ada Augusta");
  await expect(page.getByText(/upcoming bookings show it too/)).toBeVisible();
  const save = page.getByRole("button", { name: "Save", exact: true });
  // A name can't be emptied.
  await firstName.fill(" ");
  await expect(save).toBeDisabled();
  await firstName.fill("Ada Augusta");
  await page.getByRole("textbox", { name: "Last Name" }).fill("King");
  await page.getByRole("textbox", { name: "Phone (optional)" }).fill("");
  await save.click();

  // Only what changed is sent; an emptied phone clears it.
  await expect
    .poll(() => edits)
    .toEqual([{ bookingGuestId: "guest_ada", lastName: "King", phone: null }]);
  await expect(page.getByText("Ada Augusta King", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit booker" })).toBeVisible();
  await assertHealthy();
});

test("saves check-in guests to the guest list and their ID to the registration (VAY-2373)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const guestWrites: Record<string, unknown>[] = [];
  const registrationWrites: Record<string, unknown>[] = [];
  let checkIns = 0;

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) =>
      route.fulfill({
        json: {
          item: {
            ...pmsWebReservation,
            source: "channel",
            assignments: pmsWebReservation.assignments.map((assignment) => ({
              ...assignment,
              channel: "booking_com",
            })),
          },
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests**`,
    (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: {
            items: [
              {
                guestId: "guest_grace",
                guestBookingId: PMS_WEB_RESERVATION_ID,
                displayName: "Grace Hopper",
                firstName: "Grace",
                lastName: "Hopper",
                email: "grace@example.com",
                phone: null,
                countryCode: "US",
              },
            ],
          },
        });
      }
      const body = route.request().postDataJSON() as { guest: Record<string, unknown> };
      guestWrites.push(body.guest);
      return route.fulfill({
        json: {
          additionalGuest: {
            guestId: "guest_grace",
            guestBookingId: PMS_WEB_RESERVATION_ID,
            displayName: "Grace Hopper",
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            phone: body.guest.phone ?? null,
            countryCode: "US",
          },
        },
      });
    },
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-in-checklist`, (route) =>
    route.fulfill({
      json: { template: { steps: [], updatedAt: null, updatedByUserId: null } },
    }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/check-in`,
    (route) => {
      checkIns += 1;
      return route.fulfill({ json: {} });
    },
  );

  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/guest-registrations/*`,
    (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      registrationWrites.push(body);
      return route.fulfill({
        json: {
          guestId: "guest_grace",
          role: "additional_guest",
          ...body,
          filledFields: Object.keys(body).filter((key) => body[key] !== null),
          updatedAt: "2026-08-15T12:00:00Z",
        },
      });
    },
  );

  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  const main = page.locator("main").first();
  await main.getByRole("button", { name: "Confirm arrival" }).click();

  // Grace came with the OTA import: her name and nationality stay as supplied, shown locked.
  await main.getByRole("button", { name: /^Add details Grace Hopper/ }).click();
  const form = main.getByRole("form", { name: "Grace Hopper" });
  await expect(form.getByRole("textbox", { name: /First name/ })).not.toBeEditable();
  await expect(form.getByRole("textbox", { name: /Nationality/ })).toHaveValue("United States");
  await expect(form.getByRole("textbox", { name: /Nationality/ })).not.toBeEditable();
  await form.getByRole("textbox", { name: "Phone" }).fill("+1 555 0100");
  await form.getByLabel(/Date of birth/).fill("09/12/1986");
  await form.getByRole("combobox", { name: /Document type/ }).selectOption("passport");
  await form.getByRole("textbox", { name: /Document number/ }).fill("C01X00T47");
  await main.getByRole("button", { name: /^Done Grace Hopper/ }).click();
  await expect(main.getByRole("button", { name: /^Edit Grace Hopper/ })).toBeVisible();

  // Names and contact go to the guest list; the ID only to the staff-only registration, which
  // saves itself field by field (VAY-2418).
  expect(guestWrites).toHaveLength(1);
  expect(guestWrites[0]).toEqual({ phone: "+1 555 0100" });
  expect(registrationWrites.at(-1)).toEqual({
    assignmentId: "assignment_ada",
    dateOfBirth: "1986-12-09",
    documentType: "passport",
    documentNumber: "C01X00T47",
    gender: null,
    staffNotes: null,
  });

  // An OTA stay has no hotel-collected payment to record here.
  const steps = page.getByRole("navigation", { name: "Check-in steps" });
  await steps.getByRole("button", { name: /^Add-ons & payment/ }).click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await steps.getByRole("button", { name: /^Keys & check-in/ }).click();
  await page.getByRole("checkbox", { name: /Room 101 · key handed over/ }).check();
  await page.getByRole("button", { name: "Complete check-in" }).click();
  await expect.poll(() => checkIns).toBe(1);
  await assertHealthy();
});
