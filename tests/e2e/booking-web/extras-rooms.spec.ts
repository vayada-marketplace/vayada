import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { mockAnyPrice } from "../support/bookFlow";
import { watchPageHealth } from "../support/pageHealth";
import { expectChoosing, key, mockGroup, STAY } from "../support/roomPickerMocks";

// VAY-2393 part 4: the Extras step lists each booked room with Change and Remove, beside the
// extras, in "Your stay" with the total and Continue (VAY-2416). Chosen extras survive.
const hotelApi = `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}`;
const stay = (adults: number) =>
  `/?checkIn=2026-11-10&checkOut=2026-11-12&adults=${adults}&rooms=2`;

async function mockExtrasCheckout(page: Page) {
  await mockBookingApis(page);
  await mockGroup(page, [], ["pay_at_property"]);
  await page.route(`${hotelApi}/checkout-config`, (route) =>
    route.fulfill({ json: { addons: [], payAtPropertyEnabled: true } }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-addons.v1",
        addons: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            name: "Airport transfer",
            currency: "EUR",
            pricingModel: "per_stay",
            maxQuantity: 1,
            maxGuests: null,
            scheduleMode: "arrival",
            bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
          },
        ],
      },
    }),
  );
  // Each room 100.00 a stay and the transfer 25.00, paid at the hotel.
  await mockAnyPrice(page, { extraMinor: 2500 });
}

async function openPage(page: Page, path: string) {
  await page.goto(path);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: "Reject analytics" }).click();
}

async function chooseGarden(page: Page, rooms: number) {
  for (let number = 1; number <= rooms; number++)
    await page
      .getByTestId("room-card-garden")
      .getByRole("button", { name: `Select for Room ${number}` })
      .click();
  await expect(page).toHaveURL(/[?&]step=extras/);
}

const addTransfer = (page: Page) =>
  page.getByRole("button", { name: "Add Airport transfer" }).click();
// A chosen extra's card offers to remove it.
const transferAdded = (page: Page) =>
  expect(page.getByRole("button", { name: "Remove Airport transfer" })).toBeVisible();

for (const width of [1440, 390]) {
  test(`lists each room on Extras and changes one, keeping the extras, at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockExtrasCheckout(page);
    await openPage(page, stay(4));
    await chooseGarden(page, 2);

    const card = page.getByRole("complementary", { name: "Your stay" });
    // On a phone the rooms are behind "Details".
    if (width === 390) await card.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.getByTestId("stay-room-2")).toBeVisible();
    const room1 = page.getByTestId("stay-room-1");
    await expect(room1).toContainText("Room 1 · Garden Double Room");
    await expect(room1).toContainText("2 Adults");
    await expect(room1).toContainText("€100");
    await expect(room1.getByRole("button", { name: "Remove Room 1 from booking" })).toBeVisible();
    await addTransfer(page);
    await transferAdded(page);
    // Priced again with the transfer.
    await expect(room1).toContainText("€100");
    await expect(card).toContainText("Airport transfer");
    await expect(card).toContainText("€25");
    await page.screenshot({
      path: testInfo.outputPath(`extras-rooms-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });

    // Change Room 1: the room cards open on Room 1, and the new place comes straight back.
    await room1.getByRole("button", { name: "Change Room 1" }).click();
    await expectChoosing(page, 1, 2);
    await expect(page.getByTestId("room-tab-1")).toContainText("changing…");
    await page
      .getByTestId("room-card-deluxe")
      .getByRole("button", { name: "Select for Room 1" })
      .click();
    await expect(page).toHaveURL(/[?&]step=extras/);
    expect(new URL(page.url()).searchParams.getAll("pick")[0]).toBe(`2-0-${key("a")}`);
    await expect(page.getByTestId("stay-room-1")).toContainText("Deluxe Double Room");
    await transferAdded(page);
    await assertHealthy();
  });
}

test("removes a room on Extras and stays while the other place still fits", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockExtrasCheckout(page);
  // 2 adults in 2 rooms: either Garden room holds both.
  await openPage(page, stay(2));
  await chooseGarden(page, 2);
  await addTransfer(page);
  await page
    .getByTestId("stay-room-2")
    .getByRole("button", { name: "Remove Room 2 from booking" })
    .click();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Room 2 removed. All 2 adults are now in one room.");
  await expect(page).toHaveURL(/[?&]step=extras/);
  // One room: its name and guests under "Your stay", with Change.
  const card = page.getByRole("complementary", { name: "Your stay" });
  await expect(page.getByTestId("stay-room-1")).toHaveCount(0);
  await expect(card).toContainText("Garden Double Room");
  await expect(card).toContainText("2 adults");
  await expect(card.getByRole("button", { name: "Change Room 1" })).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll("pick")).toEqual([`2-0-${key("f")}`]);
  await transferAdded(page);

  // Undo: both rooms are back, with the extra.
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("stay-room-2")).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll("pick")).toHaveLength(2);
  await transferAdded(page);
  await assertHealthy();
});

test("removes a room on Extras and goes back to the cards when the place left is too small", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockExtrasCheckout(page);
  // 4 adults in 2 rooms: one Garden room can't hold all 4.
  await openPage(page, stay(4));
  await chooseGarden(page, 2);
  await addTransfer(page);
  await page
    .getByTestId("stay-room-2")
    .getByRole("button", { name: "Remove Room 2 from booking" })
    .click();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText(
    "Room 2 removed. All 4 adults are now in one room. Your remaining place is too small – pick another.",
  );
  await expect(page.getByTestId("none-fits")).toBeVisible();
  await expect(page.getByTestId("room-card-garden")).toContainText("Your choice");

  // Undo goes back to Extras as it was.
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page).toHaveURL(/[?&]step=extras/);
  await expect(page.getByTestId("stay-room-2")).toBeVisible();
  await transferAdded(page);
  await assertHealthy();
});

test("keeps a child's age and the extras when a family changes a room", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockExtrasCheckout(page);
  // 3 adults and a child in 2 rooms: Room 2 is 1 adult and the child.
  await openPage(page, STAY);
  for (const number of [1, 2])
    await page
      .getByTestId("room-card-garden")
      .getByRole("button", { name: `Select for Room ${number}` })
      .click();
  await page.getByLabel("Child 1: age at check-in").selectOption("7");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("stay-room-2")).toContainText("Room 2 · Garden Double Room");
  await expect(page.getByTestId("stay-room-2")).toContainText("1 Adult, 1 Child");
  await addTransfer(page);

  await page.getByRole("button", { name: "Change Room 1" }).click();
  await page
    .getByTestId("room-card-deluxe")
    .getByRole("button", { name: "Select for Room 1" })
    .click();
  // Straight back to Extras: the child's age is kept, so nothing is asked again.
  await expect(page.getByTestId("stay-room-1")).toContainText("Deluxe Double Room");
  await expect(page.getByTestId("stay-room-2")).toContainText("1 Adult, 1 Child");
  await expect(page.getByLabel("Child 1: age at check-in")).toHaveCount(0);
  await transferAdded(page);
  await assertHealthy();
});
