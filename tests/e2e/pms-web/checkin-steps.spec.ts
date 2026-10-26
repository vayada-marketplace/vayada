import { expect, test, type Page } from "@playwright/test";
import { PMS_WEB_RESERVATION_ID } from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { mockCheckinFlow } from "../support/checkinFlowMocks";

// VAY-2373 part 5: check-in steps 1 and 2, as approved in Paper (VAY-2372-2374 Check-in, p-16-0).
test.use({ timezoneId: "Europe/Vienna" });

const main = (page: Page) => page.locator("main").first();

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

    // Step 1: the facts and the request; Continue waits for "I have read the request".
    await expect(main(page).getByText("Step 1 of 4")).toBeVisible();
    await expect(main(page).getByText("4 adults · 2 rooms")).toBeVisible();
    await expect(main(page).getByText("Booking.com", { exact: true })).toBeVisible();
    const proceed = main(page).getByRole("button", { name: "Continue" });
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
    await proceed.click();

    // Step 2: each room with its dates, the one leaving first flagged; guests grouped by room.
    await expect(main(page).getByText("Step 2 of 4")).toBeVisible();
    await expect(main(page).getByText("Departs earlier")).toHaveCount(1);
    await expect(main(page).getByRole("heading", { name: /^Room 104 · Aug 15/ })).toBeVisible();
    await expect(main(page).getByRole("heading", { name: /^Room 101 · Aug 15/ })).toBeVisible();
    await expect(main(page).getByRole("button", { name: /^View Ada Lovelace/ })).toBeVisible();
    await expect(main(page).getByRole("button", { name: /^Complete Grace Hopper/ })).toBeVisible();
    await expect(main(page).getByRole("button", { name: /^Complete Guest 3/ })).toBeVisible();
    await expect(main(page).getByText("3 guests incomplete · you can finish later")).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await testInfo.attach(`checkin-step2-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await assertHealthy();
  });
}

test("records a new guest's details and ID, sleeping in the room they're listed under", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinFlow(page, { confirmSpecialRequest: false });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Continue" }).click();

  await main(page)
    .getByRole("button", { name: /^Complete Guest 3/ })
    .click();
  const form = main(page).getByRole("form", { name: "Guest 3" });
  await form.getByRole("button", { name: "Save guest" }).click();
  await expect(form.getByRole("alert")).toHaveText("Enter the guest’s first and last name.");
  await form.getByRole("textbox", { name: /First name/ }).fill("Alan");
  await form.getByRole("textbox", { name: /Last name/ }).fill("Turing");
  await form.getByRole("combobox", { name: /Nationality/ }).fill("United Kingdom");
  await form.getByLabel(/Date of birth/).fill("1912-06-23");
  // Still "ID missing" until the document is there.
  await expect(form.getByText(/Still empty: Document type and Document number/)).toBeVisible();
  await form.getByRole("combobox", { name: /Document type/ }).selectOption("passport");
  await form.getByRole("textbox", { name: /Document number/ }).fill("C01X00T47");
  await expect(form.getByRole("button", { name: "Room 101" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await form.getByRole("textbox", { name: /Guest notes/ }).fill("Vegetarian");
  await form.getByRole("button", { name: "Save guest" }).click();
  await expect(main(page).getByRole("button", { name: /^View Alan Turing/ })).toBeVisible();

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
  await expect(main(page).getByText("2 guests incomplete · you can finish later")).toBeVisible();
  await assertHealthy();
});

test("moves a room to a free room of any type and keeps the booked rate", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockCheckinFlow(page, { confirmSpecialRequest: false });
  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);
  await main(page).getByRole("button", { name: "Continue" }).click();

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
  await main(page).getByRole("button", { name: "Continue" }).click();
  await expect(main(page).getByRole("button", { name: /^Change room/ })).toHaveCount(0);
  await expect(main(page).getByText("3 guests still need details before check-in")).toBeVisible();
  await expect(main(page).getByRole("button", { name: "Continue" })).toBeDisabled();
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
  await main(page).getByRole("button", { name: "Continue" }).click();
  await main(page).getByRole("button", { name: "Continue" }).click();
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
  const proceed = main(page).getByRole("button", { name: "Continue" });
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

  // One key handed over; the other key and the missing guests stay open on the reservation.
  await main(page)
    .getByRole("checkbox", { name: /Room 104 · key handed over/ })
    .check();
  await expect(main(page).getByText("2 open items stay on the reservation")).toBeVisible();
  await main(page).getByRole("button", { name: "Check in 4 guests" }).click();

  await expect(page.getByRole("heading", { name: "Ada Lovelace is checked in" })).toBeVisible();
  await expect(page.getByText("3 guests still need registration details")).toBeVisible();
  await expect(page.getByText("Key for Room 101 not handed over")).toBeVisible();
  expect(writes.checkIn).toHaveLength(1);
  expect(writes.checkIn[0]).toMatchObject({
    pendingFlags: [
      expect.stringMatching(/^Registration details missing: Grace Hopper \(ID missing\)/),
      "Key for Room 101 not handed over",
    ],
    stepResults: expect.arrayContaining([
      expect.objectContaining({ stepId: "key:assignment_1", value: true }),
      expect.objectContaining({ stepId: "key:assignment_2", value: false }),
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
  await main(page).getByRole("button", { name: "Continue" }).click();
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
  await main(page).getByRole("button", { name: "Continue" }).click();
  await expect(main(page).getByText("Step 4 of 4")).toBeVisible();
  expect(writes.chargeWaived).toHaveLength(1);
  await assertHealthy();
});
