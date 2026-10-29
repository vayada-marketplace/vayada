import { expect, test, type Page } from "@playwright/test";
import { PMS_WEB_RESERVATION_ID } from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { mockCheckinFlow } from "../support/checkinFlowMocks";

// VAY-2373 part 5: check-in steps 1 and 2, as approved in Paper (VAY-2372-2374 Check-in, p-16-0).
test.use({ timezoneId: "Europe/Vienna" });

const main = (page: Page) => page.locator("main").first();
const bookingCard = (page: Page) => page.getByRole("complementary", { name: "Booking" });

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`walks the arrival and the rooms and guests as approved at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height });
    await mockCheckinFlow(page);
    await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);

    // Step 1: the facts and the request; the Booking card's button waits for "I have read the
    // request" (VAY-2418).
    await expect(main(page).getByText("Step 1 of 4")).toBeVisible();
    await expect(main(page).getByText("4 adults · 2 rooms")).toBeVisible();
    await expect(main(page).getByText("Booking.com", { exact: true })).toBeVisible();
    const proceed = bookingCard(page).getByRole("button", { name: "Confirm arrival" });
    await expect(proceed).toBeDisabled();
    await main(page).getByRole("checkbox", { name: "I have read the request" }).check();
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await testInfo.attach(`checkin-step1-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    if (width === 1440)
      // The sidebar shrinks to icons on the check-in; its toggle still says what it does.
      await expect(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await proceed.click();

    // Step 2: each room with its dates, the one leaving first flagged; guests grouped by room.
    await expect(main(page).getByText("Step 2 of 4")).toBeVisible();
    await expect(main(page).getByText("Departs earlier")).toHaveCount(1);
    await expect(main(page).getByRole("heading", { name: /^Room 104 · Aug 15/ })).toBeVisible();
    await expect(main(page).getByRole("heading", { name: /^Room 101 · Aug 15/ })).toBeVisible();
    await expect(main(page).getByRole("button", { name: /^Edit Ada Lovelace/ })).toBeVisible();
    await expect(
      main(page).getByRole("button", { name: /^Add details Grace Hopper/ }),
    ).toBeVisible();
    await expect(main(page).getByRole("button", { name: /^Add details Guest 3/ })).toBeVisible();
    // VAY-2418: each card says how many required fields are still empty.
    await expect(main(page).getByText("ID missing · 2 required fields left")).toBeVisible();
    await expect(main(page).getByText("Details missing · 6 required fields")).toHaveCount(2);
    await expect(main(page).getByText("3 guests incomplete · you can finish later")).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await testInfo.attach(`checkin-step2-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await assertHealthy();
  });
}

// VAY-2418: each step's button sits at the foot of the sticky Booking card, in view on a 13" laptop.
test("keeps every step's button in the sticky Booking card on a 13-inch laptop", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 1280, height: 720 });
  const writes = await mockCheckinFlow(page);
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  const card = bookingCard(page);
  const shoot = async (name: string) =>
    testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
  // Scroll the step under the pointer to its end: the card and its button stay put.
  const scrollStep = async () => {
    await page.mouse.move(400, 500);
    await page.mouse.wheel(0, 4000);
  };

  await expect(card.getByText(/^VAY-.+ · Booking\.com$/)).toBeVisible();
  await expect(card.getByRole("link", { name: /^View/ })).toHaveAttribute(
    "href",
    `/bookings/${PMS_WEB_RESERVATION_ID}`,
  );
  await expect(card.getByText("Booker")).toHaveCount(0);
  const arrival = card.getByRole("button", { name: "Confirm arrival" });
  await expect(arrival).toBeInViewport();
  await expect(arrival).toBeDisabled();
  await expect(card.getByText("Tick “I have read the request” to continue")).toBeVisible();
  await main(page).getByRole("checkbox", { name: "I have read the request" }).check();
  await expect(card.getByText("Booking details look correct")).toBeVisible();
  await expect(card.getByRole("button", { name: /^Back to/ })).toHaveCount(0);
  await shoot("checkin-card-step1-1280");
  await arrival.click();

  await expect(main(page).getByText("Step 2 of 4")).toBeVisible();
  const guests = card.getByText("1 of 4 registered");
  await expect(guests).toHaveClass(/text-amber-700/);
  await expect(card.getByText("3 guests incomplete · you can finish later")).toBeVisible();
  await scrollStep();
  const toAddons = card.getByRole("button", { name: "Continue to add-ons" });
  await expect(toAddons).toBeInViewport();
  await shoot("checkin-card-step2-1280");
  await card.getByRole("button", { name: "Back to Arrival" }).click();
  await expect(main(page).getByText("Step 1 of 4")).toBeVisible();
  await card.getByRole("button", { name: "Confirm arrival" }).click();
  await toAddons.click();

  await expect(main(page).getByText("Step 3 of 4")).toBeVisible();
  const toKeys = card.getByRole("button", { name: "Continue to keys" });
  await expect(toKeys).toBeDisabled();
  await expect(card.getByText("Choose how the balance is settled")).toBeVisible();
  await main(page)
    .getByRole("radio", { name: /At check-out/ })
    .click();
  await scrollStep();
  await expect(toKeys).toBeInViewport();
  await shoot("checkin-card-step3-1280");
  await toKeys.click();

  await expect(main(page).getByText("Step 4 of 4")).toBeVisible();
  const complete = card.getByRole("button", { name: "Complete check-in" });
  await expect(complete).toBeInViewport();
  await expect(complete).toBeDisabled();
  await expect(card.getByText("Hand over 2 keys to finish")).toHaveClass(/text-amber-700/);
  await expect(card.getByText("0 of 2", { exact: true })).toBeVisible();
  for (const room of ["104", "101"])
    await main(page)
      .getByRole("checkbox", { name: new RegExp(`Room ${room} · key handed over`) })
      .check();
  await expect(card.getByText("2 of 2", { exact: true })).toBeVisible();
  await expect(complete).toBeEnabled();
  await shoot("checkin-card-step4-1280");
  await complete.click();
  await expect(page.getByRole("heading", { name: "Ada Lovelace is checked in" })).toBeVisible();
  expect(writes.checkIn).toHaveLength(1);
  await assertHealthy();
});

test("lists a new guest on Done, with their ID, in the room they're listed under", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinFlow(page, { confirmSpecialRequest: false });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();

  await main(page)
    .getByRole("button", { name: /^Add details Guest 3/ })
    .click();
  const form = main(page).getByRole("form", { name: "Guest 3" });
  // VAY-2418: no Save, Cancel or Close; a guest nobody entered yet is added on Done.
  await expect(form.getByText("This guest is added when you click Done")).toBeVisible();
  await expect(main(page).getByRole("button", { name: /^(Save guest|Cancel|Close)/ })).toHaveCount(
    0,
  );
  await expect(form.getByText(/^Still empty/)).toHaveCount(0);

  // Clicking elsewhere lists nobody yet; Done without both names says so and holds the step.
  await form.getByRole("textbox", { name: /Document number/ }).fill("C01X00T47");
  await main(page).getByRole("heading", { name: "Guests", exact: true }).click();
  await page.waitForTimeout(300);
  await expect(form.locator('p[role="alert"]')).toHaveCount(0);
  await main(page)
    .getByRole("button", { name: /^Done Guest 3/ })
    .click();
  await expect(form.locator('p[role="alert"]')).toHaveText(
    "Enter the guest’s first and last name.",
  );
  const proceed = bookingCard(page).getByRole("button", { name: "Continue to add-ons" });
  await expect(proceed).toBeDisabled();
  await expect(bookingCard(page).getByText("A guest’s details aren’t saved yet")).toBeVisible();

  await form.getByRole("textbox", { name: /First name/ }).fill("Alan");
  await form.getByRole("textbox", { name: /Last name/ }).fill("Turing");
  await form.getByRole("combobox", { name: /Nationality/ }).fill("United Kingdom");
  const birth = form.getByRole("textbox", { name: /Date of birth/ });
  await expect(birth).toHaveAttribute("placeholder", "DD / MM / YYYY");
  await birth.pressSequentially("23061912");
  await expect(birth).toHaveValue("23 / 06 / 1912");
  await form.getByRole("combobox", { name: /Document type/ }).selectOption("passport");
  await expect(form.getByRole("button", { name: "Room 101" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await form.getByRole("textbox", { name: /Guest notes/ }).fill("Vegetarian");
  // Moving between a new guest's fields lists nobody yet.
  expect(writes.guests).toHaveLength(0);
  await main(page)
    .getByRole("button", { name: /^Done Guest 3/ })
    .click();
  await expect(main(page).getByRole("button", { name: /^Edit Alan Turing/ })).toBeVisible();

  expect(writes.guests).toEqual([
    expect.objectContaining({ firstName: "Alan", lastName: "Turing", countryCode: "GB" }),
  ]);
  for (const field of ["dateOfBirth", "documentNumber", "staffNotes"])
    expect(writes.guests[0]).not.toHaveProperty(field);
  expect(writes.registrations).toEqual([
    {
      guestId: "guest_new",
      body: {
        assignmentId: "assignment_2",
        dateOfBirth: "1912-06-23",
        documentType: "passport",
        documentNumber: "C01X00T47",
        gender: null,
        staffNotes: "Vegetarian",
      },
    },
  ]);
  await expect(proceed).toBeEnabled();
  await expect(main(page).getByText("2 guests incomplete · you can finish later")).toBeVisible();
  await assertHealthy();
});

test("saves a listed guest's field when staff leave it, sending only the change", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinFlow(page, { confirmSpecialRequest: false });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();
  // Straight from Ada's open form to Grace's (same room): Grace gets a form of her own.
  await main(page)
    .getByRole("button", { name: /^Edit Ada Lovelace/ })
    .click();
  await main(page)
    .getByRole("button", { name: /^Add details Grace Hopper/ })
    .click();
  const form = main(page).getByRole("form", { name: "Grace Hopper" });
  await expect(main(page).getByRole("form", { name: "Ada Lovelace" })).toHaveCount(0);
  await expect(form.getByText("Changes save automatically")).toBeVisible();

  // Grace came with the OTA import: her name shows as it came, on white, marked as locked.
  const firstName = form.getByRole("textbox", { name: /First name/ });
  await expect(firstName).toHaveValue("Grace");
  await expect(firstName).not.toBeEditable();
  await expect(firstName).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(form.getByText("From the booking").first()).toBeVisible();

  // Every field has the same label and input; no browser date picker.
  for (const name of [/Phone/, /Nationality/, /Document type/, /Document number/, /Date of birth/])
    await expect(form.getByLabel(name)).toHaveCSS("height", "44px");
  await expect(form.getByRole("textbox", { name: /Date of birth/ })).toHaveAttribute(
    "type",
    "text",
  );

  await form.getByRole("textbox", { name: "Phone" }).fill("+1 555 0100");
  await form.getByRole("combobox", { name: /Document type/ }).focus();
  await expect.poll(() => writes.guests).toEqual([{ phone: "+1 555 0100" }]);
  expect(writes.registrations).toHaveLength(0);

  await form.getByRole("combobox", { name: /Document type/ }).selectOption("passport");
  await form.getByRole("textbox", { name: /Document number/ }).fill("C01X00T47");
  await form.getByRole("textbox", { name: /Date of birth/ }).pressSequentially("09121906");
  await form.getByRole("textbox", { name: /Guest notes/ }).focus();
  await expect
    .poll(() => writes.registrations.at(-1)?.body)
    .toEqual({
      assignmentId: "assignment_1",
      dateOfBirth: "1906-12-09",
      documentType: "passport",
      documentNumber: "C01X00T47",
      gender: null,
      staffNotes: null,
    });
  // Leaving a field without changing it sends nothing.
  const sent = writes.registrations.length;
  await form.getByRole("textbox", { name: "Phone" }).focus();
  await form.getByRole("textbox", { name: /Guest notes/ }).focus();
  await page.waitForTimeout(300);
  expect(writes.registrations).toHaveLength(sent);
  expect(writes.guests).toHaveLength(1);

  // Moving her to Room 101 saves at once, but the open form stays where it is, with the note
  // being typed, until Done.
  await form.getByRole("button", { name: "Room 101" }).click();
  const notes = form.getByRole("textbox", { name: /Guest notes/ });
  await notes.click();
  await expect.poll(() => writes.registrations.at(-1)?.body.assignmentId).toBe("assignment_2");
  await notes.pressSequentially("Late arrival");
  await expect(notes).toBeFocused();
  await expect(notes).toHaveValue("Late arrival");
  const group = (room: string) =>
    main(page)
      .locator("div")
      .filter({ has: page.getByRole("heading", { name: new RegExp(`^Room ${room} · Aug 15`) }) })
      .last();
  await expect(group("104").getByRole("form", { name: "Grace Hopper" })).toBeVisible();
  await main(page)
    .getByRole("button", { name: /^Done Grace Hopper/ })
    .click();
  await expect.poll(() => writes.registrations.at(-1)?.body.staffNotes).toBe("Late arrival");
  await expect(group("101").getByRole("button", { name: /^Edit Grace Hopper/ })).toBeVisible();
  await expect(main(page).getByText("2 of 4 registered").first()).toBeVisible();
  await assertHealthy();
});

// No page-health watch: this test fails a save on purpose, which the browser logs.
test("holds the step on a date it can't read or a failed save, and lists a new guest only once", async ({
  page,
}) => {
  const writes = await mockCheckinFlow(page, { confirmSpecialRequest: false });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();
  await main(page)
    .getByRole("button", { name: /^Add details Grace Hopper/ })
    .click();
  const grace = main(page).getByRole("form", { name: "Grace Hopper" });
  const proceed = bookingCard(page).getByRole("button", { name: "Continue to add-ons" });
  const notSaved = bookingCard(page).getByText("A guest’s details aren’t saved yet");

  const birth = grace.getByRole("textbox", { name: /Date of birth/ });
  await birth.pressSequentially("31021990");
  await grace.getByRole("textbox", { name: /Document number/ }).focus();
  await expect(grace.locator('p[role="alert"]')).toHaveText(
    "Enter a real date of birth as DD / MM / YYYY.",
  );
  await expect(birth).toHaveAttribute("aria-invalid", "true");
  await expect(proceed).toBeDisabled();
  await expect(notSaved).toBeVisible();
  // The step bar can't leave the guest behind either.
  await page
    .getByRole("navigation", { name: "Check-in steps" })
    .getByRole("button", { name: /^Arrival/ })
    .click();
  await expect(main(page).getByText("Step 2 of 4")).toBeVisible();
  expect(writes.registrations).toHaveLength(0);
  // Clearing the date fixes it: nothing to send.
  await birth.fill("");
  await grace.getByRole("textbox", { name: /Document number/ }).focus();
  await expect(notSaved).toHaveCount(0);
  await main(page)
    .getByRole("button", { name: /^Done Grace Hopper/ })
    .click();

  // A new guest whose registration fails: listed once, the form keeps what was typed and the
  // step waits for "Try again".
  let fail = true;
  await page.route(
    `**/api/pms/properties/*/reservations/${PMS_WEB_RESERVATION_ID}/guest-registrations/*`,
    (route) => (fail ? route.fulfill({ status: 503, json: {} }) : route.fallback()),
  );
  await main(page)
    .getByRole("button", { name: /^Add details Guest 3/ })
    .click();
  const guest = main(page).getByRole("form", { name: "Guest 3" });
  await guest.getByRole("textbox", { name: /First name/ }).fill("Alan");
  await guest.getByRole("textbox", { name: /Last name/ }).fill("Turing");
  await guest.getByRole("textbox", { name: /Document number/ }).fill("C01X00T47");
  await main(page)
    .getByRole("button", { name: /^Done Guest 3/ })
    .click();
  const alan = main(page).getByRole("form", { name: "Alan Turing" });
  await expect(alan.locator('p[role="alert"]')).toContainText("Try again");
  await expect(alan.getByRole("textbox", { name: /Document number/ })).toHaveValue("C01X00T47");
  await expect(proceed).toBeDisabled();
  expect(writes.guests).toHaveLength(1);
  fail = false;
  await alan.getByRole("button", { name: "Try again" }).click();
  await expect(alan.locator('p[role="alert"]')).toHaveCount(0);
  await expect(notSaved).toHaveCount(0);
  expect(writes.guests).toHaveLength(1);
  expect(writes.registrations.at(-1)?.body).toMatchObject({ documentNumber: "C01X00T47" });
  await expect(proceed).toBeEnabled();
  await proceed.click();
  await expect(main(page).getByText("Step 3 of 4")).toBeVisible();
});

test("keeps staff on Rooms & guests when the save on the way out leaves a guest incomplete", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockCheckinFlow(page, {
    confirmSpecialRequest: false,
    registrationScope: "booker",
    allowIncompleteGuests: false,
  });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();
  const proceed = bookingCard(page).getByRole("button", { name: "Continue to add-ons" });
  await expect(proceed).toBeEnabled();
  await main(page)
    .getByRole("button", { name: /^Edit Ada Lovelace/ })
    .click();
  const form = main(page).getByRole("form", { name: "Ada Lovelace" });
  await form.getByRole("combobox", { name: /Document type/ }).selectOption("passport");
  // The fake API keeps only what was sent, so this save leaves her document number and date
  // of birth empty: the step is judged on that, not on what the page showed before the click.
  await proceed.click();
  await expect(
    bookingCard(page).getByText("1 guest still needs details before check-in"),
  ).toBeVisible();
  await expect(main(page).getByText("Step 2 of 4")).toBeVisible();
  await expect(proceed).toBeDisabled();
  await assertHealthy();
});

test("moves a room to a free room of any type and keeps the booked rate", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinFlow(page, { confirmSpecialRequest: false });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();

  await main(page).getByRole("button", { name: "Change room Room 104" }).click();
  const picker = main(page).getByRole("group", { name: /^Move Room 104 · Aug 15/ });
  await expect(
    picker.getByText("The booked rate stays the same", { exact: false }).first(),
  ).toBeVisible();
  const option = (number: string) =>
    picker.getByRole("radio", { name: new RegExp(`Room ${number}`) });
  await expect(option("104")).toBeDisabled();
  await expect(picker.getByText("Current")).toBeVisible();
  await expect(option("106")).toBeDisabled();
  await expect(picker.getByText(/^Occupied Aug 14/)).toBeVisible();
  await expect(option("101")).toBeDisabled();
  await expect(picker.getByText("Already in this booking")).toBeVisible();
  await expect(option("103")).toBeDisabled();
  await expect(picker.getByText("Out of service")).toBeVisible();
  await expect(option("105")).toBeEnabled();
  await option("102").check();
  await picker.getByRole("button", { name: "Move to Room 102" }).click();

  await expect(picker).toHaveCount(0);
  await expect(main(page).getByText("Booked as Room 104")).toBeVisible();
  await expect(main(page).getByRole("heading", { name: /^Room 102 · Aug 15/ })).toBeVisible();
  // The booked rate is kept: no target-rate policy is sent.
  expect(writes.moves).toEqual([
    expect.objectContaining({ action: "move", roomId: "room_102", assignmentId: "assignment_1" }),
  ]);
  expect(writes.moves[0]).not.toHaveProperty("ratePolicy");
  await assertHealthy();
});

test("follows Settings → Check-in: no room changes, every guest complete first", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockCheckinFlow(page, {
    showSpecialRequest: false,
    allowRoomChanges: false,
    allowIncompleteGuests: false,
  });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);

  await expect(main(page).getByText(/We arrive late/)).toHaveCount(0);
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();
  await expect(main(page).getByRole("button", { name: /^Change room/ })).toHaveCount(0);
  await expect(main(page).getByText("3 guests still need details before check-in")).toBeVisible();
  await expect(main(page).getByRole("button", { name: "Continue to add-ons" })).toBeDisabled();
  // The step bar can't skip past them either.
  await page
    .getByRole("navigation", { name: "Check-in steps" })
    .getByRole("button", { name: /^Keys & check-in/ })
    .click();
  await expect(main(page).getByText("Step 2 of 4")).toBeVisible();
  await assertHealthy();
});

// VAY-2373 part 6: steps 3 and 4 and the done screen.
const stepBar = (page: Page) => page.getByRole("navigation", { name: "Check-in steps" });

async function toPayment(page: Page) {
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("checkbox", { name: "I have read the request" }).check();
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();
  await main(page).getByRole("button", { name: "Continue to add-ons" }).click();
  await expect(main(page).getByText("Step 3 of 4")).toBeVisible();
}

test("adds breakfast at the desk, takes the balance in cash, hands over a key and checks in", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinFlow(page);
  await toPayment(page);

  // Breakfast for 2 guests × 2 nights + 2 guests × 4 nights = 12 guest-nights at €8.
  await expect(
    main(page).getByText(/^€8(\.00)? per guest per night · 12 guest-nights$/),
  ).toBeVisible();
  await main(page).getByRole("button", { name: "Add Breakfast" }).click();
  await expect(main(page).getByText(/^Breakfast \(added now\)$/)).toBeVisible();
  const dueNow = main(page).getByText("Due now").locator("..");
  await expect(dueNow).toContainText("€696");
  // Settings → Check-in requires a choice before Continue.
  const proceed = main(page).getByRole("button", { name: "Continue to keys" });
  await expect(proceed).toBeDisabled();
  await main(page)
    .getByRole("radio", { name: /Collect now/ })
    .click();
  await main(page).getByRole("button", { name: "Cash", exact: true }).click();
  await expect(main(page).getByText(/Records €696(\.00)? as paid by Cash/)).toBeVisible();
  await proceed.click();

  await expect(main(page).getByText("Step 4 of 4")).toBeVisible();
  expect(writes.charges).toEqual([
    expect.objectContaining({ label: "Breakfast", amountDecimal: "96.00", currency: "EUR" }),
  ]);
  expect(writes.markPaid).toEqual([expect.objectContaining({ settlementMethod: "cash" })]);
  expect(writes.chargePaid).toHaveLength(1);
  await expect(main(page).getByText(/€696(\.00)? · Cash, recorded/)).toBeVisible();

  // Every key is handed over before the check-in (VAY-2418); the missing guests stay open on the
  // reservation.
  const complete = bookingCard(page).getByRole("button", { name: "Complete check-in" });
  await expect(bookingCard(page).getByText("Hand over 2 keys to finish")).toBeVisible();
  await main(page)
    .getByRole("checkbox", { name: /Room 104 · key handed over/ })
    .check();
  await expect(bookingCard(page).getByText("Hand over 1 key to finish")).toBeVisible();
  await expect(complete).toBeDisabled();
  await main(page)
    .getByRole("checkbox", { name: /Room 101 · key handed over/ })
    .check();
  await expect(bookingCard(page).getByText("1 open item stays on the reservation")).toBeVisible();
  await complete.click();

  await expect(page.getByRole("heading", { name: "Ada Lovelace is checked in" })).toBeVisible();
  await expect(page.getByText("3 guests still need registration details")).toBeVisible();
  expect(writes.checkIn).toHaveLength(1);
  expect(writes.checkIn[0]).toMatchObject({
    pendingFlags: [
      expect.stringMatching(/^Registration details missing: Grace Hopper \(ID missing\)/),
    ],
    stepResults: expect.arrayContaining([
      expect.objectContaining({ stepId: "key:assignment_1", value: true }),
      expect.objectContaining({ stepId: "key:assignment_2", value: true }),
      expect.objectContaining({ stepId: "payment", value: expect.stringMatching(/^recorded: /) }),
    ]),
  });
  await assertHealthy();
});

test("goes straight on when there is nothing to pay, and can leave the balance for check-out", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinFlow(
    page,
    { keyHandover: "none" },
    {
      pricing: {
        totalAmount: { amountDecimal: "600.00", currency: "EUR" },
        balanceAmount: { amountDecimal: "0.00", currency: "EUR" },
      },
      payment: { method: "pay_at_property", expectedMethod: "pay_at_property", status: "paid" },
    },
  );
  await toPayment(page);
  await expect(main(page).getByText("Nothing to pay: the stay is paid in full.")).toBeVisible();
  await expect(main(page).getByRole("radio")).toHaveCount(0);

  // An add-on added now is due; it can stay open until check-out.
  await main(page).getByRole("button", { name: "More: Scooter rental" }).click();
  await main(page).getByRole("button", { name: "More: Scooter rental" }).click();
  await expect(main(page).getByText("Due now").locator("..")).toContainText("€80");
  await main(page)
    .getByRole("radio", { name: /At check-out/ })
    .click();
  await main(page).getByRole("button", { name: "Continue to keys" }).click();
  await expect(main(page).getByText("Step 4 of 4")).toBeVisible();
  expect(writes.charges).toEqual([
    expect.objectContaining({ label: "Scooter rental × 2", amountDecimal: "80.00" }),
  ]);
  expect(writes.markPaid).toHaveLength(0);
  expect(writes.chargePaid).toHaveLength(0);
  // No key step in Settings → Check-in: no key boxes.
  await expect(main(page).getByRole("checkbox", { name: /key handed over/ })).toHaveCount(0);
  await expect(main(page).getByText(/^€80(\.00)? at check-out$/)).toBeVisible();

  // Back to step 3 and remove the scooters: the charge is waived on Continue.
  await stepBar(page)
    .getByRole("button", { name: /^Add-ons & payment/ })
    .click();
  await main(page).getByRole("button", { name: "Fewer: Scooter rental" }).click();
  await main(page).getByRole("button", { name: "Fewer: Scooter rental" }).click();
  await main(page).getByRole("button", { name: "Continue to keys" }).click();
  await expect(main(page).getByText("Step 4 of 4")).toBeVisible();
  expect(writes.chargeWaived).toHaveLength(1);
  await assertHealthy();
});

test("keeps a guest's recorded status when staff can't see ID details", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockCheckinFlow(page, { confirmSpecialRequest: false });
  // Staff without guest-contact access: the ID values are hidden, but which fields are filled isn't.
  await page.route(
    `**/api/pms/properties/*/reservations/${PMS_WEB_RESERVATION_ID}/guest-registrations`,
    (route) =>
      route.fulfill({
        json: {
          guestBookingId: PMS_WEB_RESERVATION_ID,
          canReadIdentity: false,
          guests: ["guest_ada", "guest_grace"].map((guestId, index) => ({
            guestId,
            role: index === 0 ? "booker" : "additional_guest",
            assignmentId: null,
            dateOfBirth: null,
            documentType: null,
            documentNumber: null,
            gender: null,
            staffNotes: null,
            filledFields: ["documentType", "documentNumber", "dateOfBirth"],
            updatedAt: null,
          })),
        },
      }),
  );
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Confirm arrival" }).click();
  await main(page)
    .getByRole("button", { name: /^Edit Grace Hopper/ })
    .click();
  const form = main(page).getByRole("form", { name: "Grace Hopper" });
  await expect(form.getByText(/ID details are only shown to staff/)).toBeVisible();
  await expect(main(page).getByText("Registered").first()).toBeVisible();
  await assertHealthy();
});
