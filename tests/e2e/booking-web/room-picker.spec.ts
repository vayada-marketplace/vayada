import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";
import { key, mockGroup, STAY } from "../support/roomPickerMocks";

// VAY-2320 / VAY-2393: a group too big for one room picks its rooms one after another, mixing
// room types; the last pick goes straight on, with no Continue button and no rooms bar.
const cardOrder = (page: Page) =>
  page
    .locator('[data-testid^="room-card-"]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-testid")));

async function openHotelPage(page: Page, path: string) {
  await page.goto(path);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.getByRole("button", { name: "Reject analytics" }).click();
}

for (const width of [1440, 390]) {
  test(`lets a group pick its rooms one after another at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockBookingApis(page);
    const stayRequests: URL[] = [];
    await mockGroup(page, stayRequests);
    await openHotelPage(page, STAY);

    // Room 1 of 2, for 2 of the 3 adults; one pill per room, and nothing to press but a card.
    const progress = page.getByTestId("rooms-progress");
    await expect(progress).toContainText("Room 1 of 2");
    await expect(progress).toContainText("Pick a place for 2 adults");
    await expect(page.getByTestId("room-pill-1")).toContainText("choosing now");
    await expect(page.getByTestId("room-pill-2")).toContainText("next");
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await expect(page.getByText("2 rooms", { exact: true })).toBeVisible();

    const deluxe = page.getByTestId("room-card-deluxe");
    await expect(deluxe).toContainText("Select your rate for room 1 · 2 Adults");
    await deluxe.getByRole("button", { name: "Select for Room 1" }).click();

    // Room 2 (1 adult, 1 child): a toast says so and the cards are sized for it.
    await expect(page.getByTestId("toast")).toHaveText(
      "Room 1: Deluxe Double Room. Now pick Room 2.",
    );
    await expect(progress).toContainText("Room 2 of 2");
    await expect(progress).toContainText("Pick a place for 1 adult and 1 child");
    await expect(page.getByTestId("room-pill-1")).toContainText("✓ Deluxe Double Room");
    await expect(page.getByTestId("room-pill-2")).toContainText("choosing now");
    // The last Deluxe is room 1's: it can't be booked twice, and moves below the rooms that fit.
    await expect(deluxe.getByRole("button", { name: "Already your Room 1" })).toBeDisabled();
    await expect(deluxe).toContainText("Your Room 1");
    const garden = page.getByTestId("room-card-garden");
    const fullPayment = garden.locator(`[data-offer-key="${key("b")}"]`);
    await expect(fullPayment).toBeDisabled();
    await expect(fullPayment).toContainText("One booking is paid one way.");
    await expect(
      page
        .getByTestId("room-card-family")
        .getByRole("button", { name: "Sold out for these dates" }),
    ).toBeDisabled();
    await expect
      .poll(() => cardOrder(page))
      .toEqual(["room-card-garden", "room-card-deluxe", "room-card-family"]);
    await page.getByTestId("toast").waitFor({ state: "hidden" });
    await page.screenshot({
      path: testInfo.outputPath(`room-2-of-2-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });

    // The last pick goes straight on: /book gets each room's rate and guests.
    await garden.getByRole("button", { name: "Select for Room 2" }).click();
    await expect(page).toHaveURL(/\/(en\/)?book\?/);
    const params = new URL(page.url()).searchParams;
    expect(params.getAll("pick")).toEqual([`2-0-${key("a")}`, `1-1-${key("f")}`]);
    expect(params.get("rooms")).toBe("2");

    // The cards asked about room 1's guests, then room 2's.
    const asked = stayRequests.map((url) => [
      url.searchParams.get("roomAdults"),
      url.searchParams.get("roomChildren"),
    ]);
    expect(asked).toContainEqual(["2", "0"]);
    expect(asked).toContainEqual(["1", "1"]);
    await assertHealthy();
  });
}

test("opens a chosen room again from its pill and replaces it directly", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, STAY);
  const garden = page.getByTestId("room-card-garden");
  await garden.getByRole("button", { name: "Select for Room 1" }).click();
  await expect(page.getByTestId("rooms-progress")).toContainText("Room 2 of 2");

  // Room 1 again: its choice stays until another one replaces it.
  await page.getByTestId("room-pill-1").click();
  await expect(page.getByTestId("rooms-progress")).toContainText("Room 1 of 2");
  await expect(page.getByTestId("room-pill-1")).toContainText("choosing now");
  await expect(garden.getByRole("button", { name: "Your Room 1 ✓" })).toBeEnabled();
  await garden.locator(`[data-offer-key="${key("e")}"]`).click();
  await expect(garden.getByRole("button", { name: "Update Room 1" })).toBeEnabled();
  await page
    .getByTestId("room-card-deluxe")
    .getByRole("button", { name: "Select for Room 1" })
    .click();
  await expect(page.getByTestId("room-pill-1")).toContainText("✓ Deluxe Double Room");
  await expect(page.getByTestId("toast")).toHaveText(
    "Room 1: Deluxe Double Room. Now pick Room 2.",
  );
  await garden.getByRole("button", { name: "Select for Room 2" }).click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  expect(new URL(page.url()).searchParams.getAll("pick")).toEqual([
    `2-0-${key("a")}`,
    `1-1-${key("f")}`,
  ]);

  // Back finds both rooms chosen; keeping the last one goes straight on again.
  await page.goBack();
  await expect(page.getByTestId("room-pill-1")).toContainText("✓ Deluxe Double Room");
  await expect(page.getByTestId("room-pill-2")).toContainText("choosing now");
  await garden.getByRole("button", { name: "Your Room 2 ✓" }).click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  await assertHealthy();
});

for (const width of [1440, 390]) {
  test(`says who sleeps where and asks again for a room the split makes too small at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockBookingApis(page);
    await mockGroup(page, []);
    // 4 adults: two rooms of 2 by default.
    await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=4");
    const garden = page.getByTestId("room-card-garden");
    await garden.getByRole("button", { name: "Select for Room 1" }).click();
    await garden.getByRole("button", { name: "Select for Room 2" }).click();
    await expect(page).toHaveURL(/\/(en\/)?book\?/);
    await page.goBack();
    // Every room chosen: the last one is open to change, the others are done.
    await expect(page.getByTestId("room-pill-1")).toContainText("✓ Garden Double Room");
    await expect(page.getByTestId("room-pill-2")).toContainText("choosing now");

    // Room 1 takes 3 of the 4 adults: its Garden room sleeps 2, so room 1 is chosen again.
    await page.getByText("4 Adults", { exact: true }).click();
    const split = page.getByTestId("who-sleeps-where");
    await expect(split).toContainText("Room 1");
    await expect(split).toContainText("2 adults");
    await split.getByRole("button", { name: "More adults in Room 1" }).click();
    await expect(split.getByRole("button", { name: "More adults in Room 1" })).toBeDisabled();
    await expect(split).toContainText("3 adults");
    await expect(split).toContainText("1 adult");
    await page.getByTestId("guest-selector").getByRole("button", { name: "Done" }).click();
    const progress = page.getByTestId("rooms-progress");
    await expect(progress).toContainText("Room 1 of 2");
    await expect(progress).toContainText("Pick a place for 3 adults");
    await expect(page.getByTestId("room-pill-1")).toContainText("choosing now");
    await expect(page.getByTestId("room-pill-2")).toContainText("✓ Garden Double Room");
    // Every room here sleeps 2: each offers to change who sleeps where instead.
    await expect(garden).toContainText("Room 1 is for 3 adults right now");
    await page.screenshot({
      path: testInfo.outputPath(`too-small-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await garden.getByRole("button", { name: "Fits 2 – change who sleeps where" }).click();
    await expect(page.getByTestId("who-sleeps-where")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`who-sleeps-where-${width}.png`),
      animations: "disabled",
    });
    await page
      .getByTestId("who-sleeps-where")
      .getByRole("button", { name: "Fewer adults in Room 1" })
      .click();
    await page.getByTestId("guest-selector").getByRole("button", { name: "Done" }).click();
    // Back to 2 + 2: both Garden rooms fit again.
    await expect(page.getByTestId("room-pill-1")).toContainText("✓ Garden Double Room");
    await expect(garden.getByRole("button", { name: "Your Room 2 ✓" })).toBeEnabled();
    await assertHealthy();
  });
}

test("starts at the fewest rooms the group needs and lets it add rooms", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, STAY);
  await expect(page.getByTestId("rooms-progress")).toContainText("Room 1 of 2");
  await page.getByText("3 Adults, 1 Child", { exact: true }).click();
  const picker = page.getByTestId("guest-selector");
  await expect(picker.getByText("4 guests need at least 2 rooms here")).toBeVisible();
  await expect(picker.getByRole("button", { name: "Fewer Rooms" })).toBeDisabled();
  await picker.getByRole("button", { name: "More Rooms" }).click();
  // Never more rooms than adults.
  await expect(picker.getByRole("button", { name: "More Rooms" })).toBeDisabled();
  await picker.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("rooms-progress")).toContainText("Room 1 of 3");
  await expect(page.getByTestId("room-pill-3")).toContainText("next");
  for (const number of [1, 2, 3])
    await page
      .getByTestId("room-card-garden")
      .getByRole("button", { name: `Select for Room ${number}` })
      .click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  expect(new URL(page.url()).searchParams.getAll("pick")).toHaveLength(3);
  // The third room, which the link didn't ask for, is still there on Back from /book.
  await page.goBack();
  await expect(page.getByTestId("rooms-progress")).toContainText("Room 3 of 3");
  await expect(page.getByTestId("room-pill-2")).toContainText("✓ Garden Double Room");
  await assertHealthy();
});
