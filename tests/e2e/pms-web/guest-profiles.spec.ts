import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { TIMO, TIMO_TWIN, mockGuests } from "../support/guestProfileMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2420: guest records in search, the Guests list and the guest profile (Timo's mockup).
test("finds a guest in search and opens their profile with every stay (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockGuests(page);
  await page.goto("/bookings");

  // The top bar's search opens with Ctrl/Cmd+K. The header listens for it from its first effects,
  // and shows the property name only after a later fetch, so wait for the name: a press before the
  // listener was lost in CI (VAY-2427).
  await expect(page.getByRole("button", { name: "Alpenrose Munich" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("timo");
  // Guests come first, the first one is chosen, Enter opens the profile.
  const first = dialog.getByRole("option").first();
  await expect(first).toContainText("Timo Schreyer");
  await expect(first).toContainText("2 reservations");
  await expect(first).toContainText("t.schreyer@example.test · +49 157 35490950 · Arriving today");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(first).toContainText("Open profile ↵");
  await expect(dialog.getByText("Guests", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Reservations", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Guests are matched by name plus email or phone")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`/guests/${TIMO}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Timo Schreyer" })).toBeVisible();
  await expect(page.getByText("Returning guest")).toBeVisible();
  await expect(page.getByText("Next arrival").locator("..")).toContainText("Aug 15");
  const data = page.getByRole("region", { name: "Guest data" });
  await expect(data.getByText("Not provided")).toHaveCount(4);

  // Both properties' stays, newest first; the other property's stay opens there.
  const history = page.getByRole("region", { name: "Stay history" });
  await expect(history.getByRole("link")).toHaveCount(2);
  await expect(history.getByRole("link").first()).toContainText("1 adult");
  const galle = history.getByRole("link", { name: /71 Pedlar St Galle Fort/ });
  await expect(galle).toContainText("Completed");
  await expect(galle).toContainText("VAY-DCFC01D5073548DE · Booking engine · Lead guest");
  await expect(galle).toHaveAttribute("href", "/bookings/guest_booking_galle");

  // Edit guest: only what changed goes to the guest record; an emptied phone clears it.
  await page.getByRole("button", { name: "Edit guest" }).click();
  await data.getByRole("textbox", { name: "Last name" }).fill("King");
  await data.getByRole("textbox", { name: "Phone" }).fill("");
  await data.getByRole("textbox", { name: "Date of birth" }).pressSequentially("31021990");
  await expect(data.getByText("Enter the date of birth as DD / MM / YYYY.")).toBeVisible();
  await expect(data.getByRole("button", { name: "Save" })).toBeDisabled();
  await data.getByRole("textbox", { name: "Date of birth" }).fill("");
  await data.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => writes.edits).toEqual([{ lastName: "King", phone: null }]);
  await expect(page.getByRole("heading", { level: 1, name: "Timo King" })).toBeVisible();
  await assertHealthy();
});

test("keeps contact hidden until the request is accepted (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockGuests(page, {
    email: null,
    phone: null,
    contactHidden: true,
    fields: {
      firstName: "Timo",
      lastName: "Schreyer",
      email: null,
      phone: null,
      countryCode: "DE",
      dateOfBirth: null,
      documentType: null,
      documentNumber: null,
    },
  });
  await page.goto(`/guests/${TIMO}`);
  const data = page.getByRole("region", { name: "Guest data" });
  await expect(data.getByText("Hidden until you accept")).toHaveCount(2);
  await page.getByRole("button", { name: "Edit guest" }).click();
  await expect(data.getByRole("textbox", { name: "Email" })).toBeDisabled();
  await expect(data.getByRole("textbox", { name: "Phone" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "More actions" })).toBeDisabled();
  await assertHealthy();
});

test("lists guests, merges a duplicate and separates a stay (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockGuests(page);
  await page.goto("/bookings");
  await page.getByRole("link", { name: "Guests", exact: true }).first().click();

  await expect(page).toHaveURL(/\/guests$/);
  const main = page.locator("main").first();
  const list = main.getByRole("list");
  await expect(list.getByRole("link")).toHaveCount(2);
  await expect(list.getByRole("link").nth(1)).toContainText("1 reservation");
  await page.getByRole("searchbox", { name: "Search guests" }).fill("nobody");
  await expect(page.getByText("No guests match “nobody”.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search guests" }).fill("");
  await list.getByRole("link").first().click();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Merge with another guest…" }).click();
  const merge = page.getByRole("dialog", { name: "Merge with another guest" });
  // The guest being viewed is not offered.
  await expect(merge.getByRole("radio")).toHaveCount(1);
  await merge.getByRole("radio").check();
  await merge.getByRole("button", { name: "Merge" }).click();
  await expect.poll(() => writes.merges).toEqual([{ guestProfileId: TIMO_TWIN }]);
  await expect(main.getByRole("status")).toContainText(
    "The stays and notes of Timo Schreyer are now on this guest.",
  );
  await expect(main.getByText("Reservations", { exact: true }).locator("..")).toContainText("3");

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Separate a stay…" }).click();
  const separate = page.getByRole("dialog", { name: "Separate a stay" });
  await separate.getByRole("radio", { name: /71 Pedlar St Galle Fort/ }).check();
  await separate.getByRole("button", { name: "Separate" }).click();
  await expect.poll(() => writes.separations).toEqual([{ bookingGuestId: "guest_timo_galle" }]);
  await expect(main.getByRole("status")).toContainText("The stay now has its own guest record.");
  await expect(page.getByRole("link", { name: "Open it" })).toHaveAttribute(
    "href",
    `/guests/${TIMO_TWIN}`,
  );
  await assertHealthy();
});

test("keeps staff notes on the guest and shows them on their reservation (VAY-2420)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockGuests(page);
  await page.goto(`/guests/${TIMO}`);

  const notes = page.getByRole("region", { name: "Guest notes" });
  await expect(notes).toContainText("Staff only · kept across all stays");
  await expect(notes).toContainText(
    "No notes yet. Notes added here show on every future reservation of Timo.",
  );
  await expect(notes.getByRole("button", { name: "Add guest note" })).toBeDisabled();
  await notes.getByRole("textbox", { name: "New note" }).fill("  Allergic to feathers  ");
  await notes.getByRole("button", { name: "Add guest note" }).click();
  await expect.poll(() => writes.notes).toEqual([{ body: "Allergic to feathers" }]);
  await expect(notes.getByRole("listitem")).toHaveCount(1);
  await expect(notes.getByRole("listitem")).toContainText("Aug 15, 2026 · Alpenrose Munich");
  await expect(notes.getByRole("textbox", { name: "New note" })).toHaveValue("");

  // Deleting asks once more, with the focus on the question; Escape goes back.
  await notes.getByRole("button", { name: "Delete guest note" }).click();
  await expect(notes.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(notes.getByRole("button", { name: "Delete guest note" })).toBeFocused();
  await notes.getByRole("button", { name: "Delete guest note" }).click();
  await notes.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => writes.deletedNotes).toEqual(["note_1"]);
  await expect(notes.getByRole("listitem")).toHaveCount(0);

  // The booker's reservation shows the same notes, with a link to the profile.
  await mockBookerReservation(page);
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const kept = page.getByRole("region", { name: "Guest notes" });
  await expect(kept).toContainText("Prefers a quiet room");
  await expect(kept.getByRole("link", { name: "Open guest profile" })).toHaveAttribute(
    "href",
    `/guests/${TIMO}`,
  );
  await assertHealthy();
});

/** The booker's reservation, linked to Timo's guest record with one kept note. */
async function mockBookerReservation(page: Page) {
  const reservation = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  for (const path of ["notes", "additional-guests"])
    await page.route(`${reservation}/${path}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${reservation}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(reservation, (route) => route.fulfill({ json: { item: pmsWebReservation } }));
  await page.route(`${reservation}/guest-profiles`, (route) =>
    route.fulfill({
      json: {
        guestBookingId: PMS_WEB_RESERVATION_ID,
        guests: [
          {
            bookingGuestId: "guest_ada",
            role: "booker",
            firstName: "Ada",
            lastName: "Lovelace",
            guestProfileId: TIMO,
            reservations: 2,
            notes: [
              {
                noteId: "note_kept",
                body: "Prefers a quiet room",
                propertyId: PMS_WEB_PROPERTY_ID,
                createdByUserId: null,
                createdAt: "2026-03-01T09:00:00.000Z",
              },
            ],
          },
        ],
      },
    }),
  );
}

test("hides Guests everywhere when it is switched off in Feature Hub (VAY-2423)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockGuests(page);
  await page.route(
    new RegExp(`/api/pms/properties/${PMS_WEB_PROPERTY_ID}/navigation-modules$`),
    (route) =>
      route.fulfill({
        json: {
          hotelId: PMS_WEB_PROPERTY_ID,
          canManage: true,
          supportedModules: ["inbox", "reviews", "guests"],
          activeModules: ["inbox", "reviews"],
          activations: [],
        },
      }),
  );
  const guestSearches: string[] = [];
  page.on("request", (request) => {
    if (/\/guests\?/.test(request.url())) guestSearches.push(request.url());
  });
  await page.goto("/bookings");

  const navigation = page.getByRole("navigation");
  await expect(navigation.getByRole("link", { name: /Reservations/ })).toBeVisible();
  await expect(navigation.getByRole("link", { name: /Inbox/ })).toBeVisible();
  await expect(navigation.getByRole("link", { name: /Guests/ })).toHaveCount(0);

  // Search finds neither the Guests page nor guests; reservations still show.
  await expect(page.getByRole("button", { name: "Alpenrose Munich" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("guests");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await expect(dialog.getByText("Guest records and their stays")).toHaveCount(0);
  await dialog.getByRole("textbox").fill("timo");
  await expect(dialog.getByText("Reservations", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Guests", { exact: true })).toHaveCount(0);
  expect(guestSearches).toEqual([]);
  await page.keyboard.press("Escape");

  // The reservation keeps the guest's notes, without the profile link.
  await mockBookerReservation(page);
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const kept = page.getByRole("region", { name: "Guest notes" });
  await expect(kept).toContainText("Prefers a quiet room");
  await expect(kept.getByRole("link", { name: "Open guest profile" })).toHaveCount(0);

  // An old link to the list or a profile goes to the Dashboard.
  await page.goto("/guests");
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`/guests/${TIMO}`);
  await expect(page).toHaveURL(/\/dashboard$/);
  await assertHealthy();
});
