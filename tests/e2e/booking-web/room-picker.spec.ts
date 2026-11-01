import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";
import { expectChoosing, key, mockGroup, ONE_ROOM_STAY, STAY } from "../support/roomPickerMocks";

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

    // Room 1 of 2, for 2 of the 3 adults; one tab per room, and nothing to press but a card.
    const help = page.getByTestId("rooms-help");
    await expectChoosing(page, 1, 2);
    await expect(help).toContainText("Pick a place for 2 adults");
    await expect(page.getByTestId("room-tab-1")).toContainText("choosing");
    await expect(page.getByTestId("room-tab-2")).toContainText("next");
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await expect(page.getByText("2 rooms", { exact: true })).toBeVisible();

    const deluxe = page.getByTestId("room-card-deluxe");
    await expect(deluxe).toContainText("Select your rate for room 1 · 2 Adults");
    await deluxe.getByRole("button", { name: "Select for Room 1" }).click();

    // Room 2 (1 adult, 1 child): a toast says so and the cards are sized for it.
    await expect(page.getByTestId("toast")).toHaveText(
      "Room 1: Deluxe Double Room. Now pick Room 2.",
    );
    await expectChoosing(page, 2, 2);
    await expect(help).toContainText("Pick a place for 1 adult and 1 child");
    await expect(page.getByTestId("room-tab-1")).toContainText("Deluxe Double Room");
    await expect(page.getByTestId("room-tab-1")).toContainText("✓");
    await expect(page.getByTestId("room-tab-2")).toContainText("choosing");
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

test("opens a chosen room again from its tab and replaces it directly", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, STAY);
  const garden = page.getByTestId("room-card-garden");
  await garden.getByRole("button", { name: "Select for Room 1" }).click();
  await expectChoosing(page, 2, 2);

  // Room 1 again: its choice stays until another one replaces it.
  await page.getByTestId("room-tab-1").click();
  await expectChoosing(page, 1, 2);
  await expect(page.getByTestId("room-tab-1")).toContainText("changing…");
  await expect(garden.getByRole("button", { name: "Your Room 1 ✓" })).toBeDisabled();
  await expect(garden).toContainText("Pick another place to swap it.");
  await garden.locator(`[data-offer-key="${key("e")}"]`).click();
  await expect(garden.getByRole("button", { name: "Update Room 1" })).toBeEnabled();
  await page
    .getByTestId("room-card-deluxe")
    .getByRole("button", { name: "Select for Room 1" })
    .click();
  await expect(page.getByTestId("room-tab-1")).toContainText("Deluxe Double Room");
  await expect(page.getByTestId("toast")).toHaveText(
    "Room 1: Deluxe Double Room. Now pick Room 2.",
  );
  await garden.getByRole("button", { name: "Select for Room 2" }).click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  expect(new URL(page.url()).searchParams.getAll("pick")).toEqual([
    `2-0-${key("a")}`,
    `1-1-${key("f")}`,
  ]);

  // Back finds both rooms chosen, and goes straight on again from there.
  await page.goBack();
  const help = page.getByTestId("rooms-help");
  await expect(help).toContainText("All 2 rooms chosen");
  await expect(page.getByTestId("room-tab-1")).toContainText("Deluxe Double Room");
  await expect(page.getByTestId("room-tab-2")).toContainText("Garden Double Room");
  await expect(garden.getByRole("button", { name: "All rooms chosen" })).toBeDisabled();
  await expect(garden).toContainText("Your Room 2");
  await help.getByRole("button", { name: /^Continue to (extras|your details)$/ }).click();
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
    await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=4&rooms=2");
    const garden = page.getByTestId("room-card-garden");
    await garden.getByRole("button", { name: "Select for Room 1" }).click();
    await garden.getByRole("button", { name: "Select for Room 2" }).click();
    await expect(page).toHaveURL(/\/(en\/)?book\?/);
    await page.goBack();
    // Every room chosen: all tabs are done.
    await expect(page.getByTestId("rooms-help")).toContainText("All 2 rooms chosen");
    await expect(page.getByTestId("room-tab-1")).toContainText("Garden Double Room");
    await expect(page.getByTestId("room-tab-2")).toContainText("Garden Double Room");

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
    const help = page.getByTestId("rooms-help");
    await expectChoosing(page, 1, 2);
    await expect(help).toContainText("Pick a place for 3 adults");
    await expect(page.getByTestId("room-tab-1")).toContainText("changing…");
    await expect(page.getByTestId("room-tab-2")).toContainText("Garden Double Room");
    // Every room here sleeps 2: each offers to change who sleeps where instead.
    await expect(garden).toContainText("Room 1 is for 3 adults right now.");
    // None of the Family Room is free: sold out, not "change who sleeps where", and last.
    await expect(
      page
        .getByTestId("room-card-family")
        .getByRole("button", { name: "Sold out for these dates" }),
    ).toBeDisabled();
    await expect.poll(() => cardOrder(page).then((order) => order.at(-1))).toBe("room-card-family");
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
    await expect(page.getByTestId("rooms-help")).toContainText("All 2 rooms chosen");
    await expect(page.getByTestId("room-tab-1")).toContainText("Garden Double Room");
    await assertHealthy();
  });
}

test("offers the rooms a group needs when no place holds it, and lets it add rooms", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  // VAY-2393: the group starts in one room and is offered the rooms it needs.
  await openHotelPage(page, ONE_ROOM_STAY);
  const noneFits = page.getByTestId("none-fits");
  await expect(noneFits).toContainText("No single place fits 4 guests.");
  await expect(page.getByTestId("room-tabs")).toHaveCount(0);
  await noneFits.getByRole("button", { name: "Book 2 rooms" }).click();
  await expectChoosing(page, 1, 2);
  await page.getByText("3 Adults, 1 Child", { exact: true }).click();
  const picker = page.getByTestId("guest-selector");
  await expect(picker.getByText("4 guests need at least 2 rooms here")).toBeVisible();
  await expect(picker.getByRole("button", { name: "Fewer Rooms" })).toBeEnabled();
  await picker.getByRole("button", { name: "More Rooms" }).click();
  // Never more rooms than adults.
  await expect(picker.getByRole("button", { name: "More Rooms" })).toBeDisabled();
  await picker.getByRole("button", { name: "Done" }).click();
  await expectChoosing(page, 1, 3);
  await expect(page.getByTestId("room-tab-3")).toContainText("next");
  for (const number of [1, 2, 3])
    await page
      .getByTestId("room-card-garden")
      .getByRole("button", { name: `Select for Room ${number}` })
      .click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  expect(new URL(page.url()).searchParams.getAll("pick")).toHaveLength(3);
  // The third room, which the link didn't ask for, is still there on Back from /book.
  await page.goBack();
  await expect(page.getByTestId("rooms-help")).toContainText("All 3 rooms chosen");
  await expect(page.getByTestId("room-tab-3")).toContainText("Garden Double Room");
  await assertHealthy();
});

// Independent review (VAY-2393): picking inside "View details" closes it first, so the page's
// own feedback shows; pressing a reopened room's tab again keeps its choice.
test("picks from inside a room's details and keeps a reopened room from its tab", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, STAY);
  await page.getByTestId("room-card-deluxe").getByRole("button", { name: "View Details" }).click();
  const details = page.getByRole("dialog", { name: "Deluxe Double Room" });
  await details.getByRole("button", { name: "Select for Room 1" }).click();
  await expect(details).toHaveCount(0);
  await expect(page.getByTestId("toast")).toHaveText(
    "Room 1: Deluxe Double Room. Now pick Room 2.",
  );
  await expectChoosing(page, 2, 2);
  await expect(page.locator("#rooms-progress-title")).toBeFocused();

  await page.getByTestId("room-tab-1").click();
  await expect(page.getByTestId("room-tab-1")).toContainText("changing…");
  await page.getByTestId("room-tab-1").click();
  await expect(page.getByTestId("room-tab-1")).toContainText("Deluxe Double Room");
  await expect(page.getByTestId("room-tab-2")).toContainText("choosing");
  await assertHealthy();
});

for (const width of [1440, 390]) {
  test(`books a place too small for the whole group for part of it at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockBookingApis(page);
    const stayRequests: URL[] = [];
    await mockGroup(page, stayRequests);
    await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=4");

    // No place sleeps 4: each free one is priced for the 2 it takes, not greyed out.
    await expect(page.getByTestId("none-fits")).toContainText("No single place fits 4 guests.");
    const garden = page.getByTestId("room-card-garden");
    const bookPart = garden.getByRole("button", { name: "Book for 2 + pick a 2nd room for 2" });
    await expect(bookPart).toBeEnabled();
    await expect(garden.locator(`[data-offer-key="${key("f")}"]`)).toContainText("€238");
    await expect(garden).not.toContainText("Not available");
    await expect(garden).toContainText("Sleeps 2 of your 4 guests.");
    await expect(page.getByTestId("none-fits")).toContainText(
      "Split your group and pick a place for each part.",
    );
    await expect(page.getByTestId("room-card-family")).toContainText("Sold Out");
    await page.screenshot({
      path: testInfo.outputPath(`one-room-too-small-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });

    // The place becomes room 1 for 2 adults; room 2 is for the other 2.
    await bookPart.click();
    await expect(page.getByTestId("toast")).toHaveText(
      "Room 1: Garden Double Room for 2. Now pick a place for the other 2.",
    );
    const help = page.getByTestId("rooms-help");
    await expectChoosing(page, 2, 2);
    await expect(help).toContainText("Pick a place for 2 adults");
    await expect(page.getByTestId("room-tab-1")).toContainText("Garden Double Room");
    await page
      .getByTestId("room-card-deluxe")
      .getByRole("button", { name: "Select for Room 2" })
      .click();
    await expect(page).toHaveURL(/\/(en\/)?book\?/);
    expect(new URL(page.url()).searchParams.getAll("pick")).toEqual([
      `2-0-${key("f")}`,
      `2-0-${key("a")}`,
    ]);
    // One room for the whole party, then room 2's guests.
    const asked = stayRequests.map((url) => url.searchParams.get("roomAdults"));
    expect(asked).toContain("4");
    expect(asked).toContain("2");
    await assertHealthy();
  });
}

// VAY-2448: no "Prefer separate rooms?" line; a group one place holds adds rooms in Guests.
test("lets a group one place holds choose separate rooms in Guests", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=2");
  await expect(page.getByTestId("select-rate-garden")).toHaveText("Select This Rate");
  await expect(page.getByText("Showing places for all 2 guests together.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prefer separate rooms?" })).toHaveCount(0);
  await expect(page.getByTestId("none-fits")).toHaveCount(0);
  await page.getByText("2 Adults", { exact: true }).click();
  const picker = page.getByTestId("guest-selector");
  await picker.getByRole("button", { name: "More Rooms" }).click();
  await picker.getByRole("button", { name: "Done" }).click();
  const help = page.getByTestId("rooms-help");
  await expectChoosing(page, 1, 2);
  await expect(help).toContainText("Pick a place for 1 adult");
  await assertHealthy();
});

// Independent review (VAY-2393): the part is priced for its adults alone, so the children go
// with the rest and the place just booked still fits Room 1.
test("books part of a group with a child and puts the child in the second room", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  const stayRequests: URL[] = [];
  await mockGroup(page, stayRequests);
  await openHotelPage(page, ONE_ROOM_STAY);
  await page
    .getByTestId("room-card-garden")
    .getByRole("button", { name: "Book for 2 + pick a 2nd room for 2" })
    .click();
  await expect(page.getByTestId("toast")).toHaveText(
    "Room 1: Garden Double Room for 2. Now pick a place for the other 2.",
  );
  const help = page.getByTestId("rooms-help");
  await expectChoosing(page, 2, 2);
  await expect(help).toContainText("Pick a place for 1 adult and 1 child");
  await expect(page.getByTestId("room-tab-1")).toContainText("Garden Double Room");
  await expect
    .poll(() =>
      stayRequests.map((url) =>
        [url.searchParams.get("roomAdults"), url.searchParams.get("roomChildren")].join("+"),
      ),
    )
    .toContain("1+1");
  await page
    .getByTestId("room-card-deluxe")
    .getByRole("button", { name: "Select for Room 2" })
    .click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  expect(new URL(page.url()).searchParams.getAll("pick")).toEqual([
    `2-0-${key("f")}`,
    `1-1-${key("a")}`,
  ]);
  await assertHealthy();
});

for (const width of [1440, 390]) {
  test(`removes a room from its tab and can undo it at ${width}px`, async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await mockBookingApis(page);
    await mockGroup(page, []);
    await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=4&rooms=2");
    const garden = page.getByTestId("room-card-garden");
    await garden.getByRole("button", { name: "Select for Room 1" }).click();
    await expectChoosing(page, 2, 2);

    // One click removes room 2: all 4 adults are in one room again, and Garden is their choice.
    await page.getByRole("button", { name: "Remove Room 2 from booking" }).click();
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("Room 2 removed. All 4 adults are now in one room.");
    await expect(page.getByTestId("room-tabs")).toHaveCount(0);
    await expect(page.getByTestId("none-fits")).toContainText("No single place fits 4 guests.");
    await expect(garden).toContainText("Your choice");
    // It sleeps 2, so it isn't moved to the top: booked for 2 again, with a second room for the
    // others.
    await expect(
      garden.getByRole("button", { name: "Book for 2 + pick a 2nd room for 2" }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`removed-to-one-room-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });

    // Undo brings room 2 back with room 1's choice.
    await toast.getByRole("button", { name: "Undo" }).click();
    await expectChoosing(page, 2, 2);
    await expect(page.getByTestId("room-tab-1")).toContainText("Garden Double Room");
    await expect(toast).toHaveCount(0);
    await assertHealthy();
  });
}

test("keeps the place that sleeps everyone and continues with it", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=2&rooms=2");
  await page
    .getByTestId("room-card-garden")
    .getByRole("button", { name: "Select for Room 1" })
    .click();
  await page.getByRole("button", { name: "Remove Room 2 from booking" }).click();
  await expect(page.getByTestId("toast")).toContainText(
    "Room 2 removed. All 2 adults are now in one room.",
  );
  const choice = page.getByTestId("select-rate-garden");
  await expect(choice).toHaveText("Continue with this place");
  await expect(page.getByTestId("room-card-garden")).toContainText("Your choice");
  // It sleeps both adults: listed first.
  await expect.poll(() => cardOrder(page).then((order) => order[0])).toBe("room-card-garden");
  await choice.click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get("offer")).toBe(key("f"));
  expect(params.getAll("pick")).toEqual([]);
  await assertHealthy();
});

// Independent review (VAY-2393): removing from the keyboard puts focus on Undo, which stays up
// while it has focus; removing a room of three keeps the others' choices in order.
test("removes rooms from the keyboard and from the middle of three", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=3&rooms=3");
  const garden = page.getByTestId("room-card-garden");
  await garden.getByRole("button", { name: "Select for Room 1" }).click();
  await garden.getByRole("button", { name: "Select for Room 2" }).click();
  await expectChoosing(page, 3, 3);

  // Room 1 goes: the old Room 2 (Garden) is Room 1 now, and Room 2 is still to choose.
  await page.getByRole("button", { name: "Remove Room 1 from booking" }).click();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Room 1 removed.");
  await expectChoosing(page, 2, 2);
  await expect(page.getByTestId("room-tab-1")).toContainText("Garden Double Room");
  await expect(page.getByTestId("room-tab-2")).toContainText("choosing");

  // From the keyboard: focus goes to Undo, and the toast waits while it has focus.
  await page.getByRole("button", { name: "Remove Room 2 from booking" }).focus();
  await page.keyboard.press("Enter");
  const undo = toast.getByRole("button", { name: "Undo" });
  await expect(undo).toBeFocused();
  await page.waitForTimeout(6500);
  await expect(undo).toBeVisible();
  await page.keyboard.press("Enter");
  await expectChoosing(page, 2, 2);
  await expect(page.locator("#rooms-progress-title")).toBeFocused();
  await assertHealthy();
});

// VAY-2412: the room tabs and the sort share one row below the heading, with one helper line
// below it; the arrows move between the tabs and Enter opens one.
test("puts the room tabs and the sort on one row and moves between the tabs from the keyboard", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, STAY);
  const tabs = page.getByTestId("room-tabs");
  const [tab1, tab2] = [page.getByTestId("room-tab-1"), page.getByTestId("room-tab-2")];
  await expectChoosing(page, 1, 2);
  await expect(tab1).toContainText("Room 1");
  await expect(tab1).toContainText("2 adults · choosing");
  await expect(tab2).toContainText("1 adult · 1 child · next");
  await expect(tab2).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("rooms-help")).toHaveText(
    "Pick a place for 2 adults. Prices are per room; children are added on the next step.",
  );
  await expect(page.getByText("Room 1 of 2")).toHaveCount(0);

  // VAY-2448: the sort is a labelled select on the heading's row; the tabs follow below it.
  const sort = page.getByRole("combobox", { name: "Sort by" });
  await expect(sort).toHaveJSProperty("tagName", "SELECT");
  const heading = page.getByRole("heading", { name: "Available Accommodations" });
  const [row, select, title] = await Promise.all([
    tabs.boundingBox(),
    sort.boundingBox(),
    heading.boundingBox(),
  ]);
  expect(Math.abs(select!.y + select!.height / 2 - (title!.y + title!.height / 2))).toBeLessThan(3);
  expect(row!.y).toBeGreaterThanOrEqual(select!.y + select!.height);
  await page.screenshot({
    path: testInfo.outputPath("room-tabs-1440.png"),
    fullPage: true,
    animations: "disabled",
  });

  // Moving between the tabs opens nothing; Enter opens Room 2.
  await tab1.focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab2).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab1).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tab2).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab1).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab2).toBeFocused();
  await expectChoosing(page, 1, 2);
  await page.keyboard.press("Enter");
  await expectChoosing(page, 2, 2);
  await expect(tab1).toContainText("next");
  await expect(page.getByTestId("rooms-help")).toContainText(
    "Pick a place for 1 adult and 1 child",
  );
  await assertHealthy();
});

test("scrolls the room tabs on a phone, with the sort below the heading and targets of 44px", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=3&rooms=3");
  await expectChoosing(page, 1, 3);
  // Three rooms don't fit across a phone: the tabs scroll sideways, not the page.
  const tabs = page.getByTestId("room-tabs");
  expect(await tabs.evaluate((list) => list.scrollWidth > list.clientWidth)).toBe(true);
  const right = await page
    .locator("#rooms")
    .evaluate(
      (rooms) =>
        rooms.getBoundingClientRect().right - parseFloat(getComputedStyle(rooms).paddingRight),
    );
  // VAY-2448: on a phone the sort wraps below the heading, and the tabs follow below it.
  const sort = page.getByRole("combobox", { name: "Sort by" });
  const heading = page.getByRole("heading", { name: "Available Accommodations" });
  const [row, select, title] = await Promise.all([
    tabs.boundingBox(),
    sort.boundingBox(),
    heading.boundingBox(),
  ]);
  expect(row!.x + row!.width).toBeLessThanOrEqual(right + 1);
  expect(select!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  expect(row!.y).toBeGreaterThanOrEqual(select!.y + select!.height);
  for (const target of [
    page.getByTestId("room-tab-1"),
    page.getByRole("button", { name: "Remove Room 1 from booking" }),
    sort,
  ]) {
    const box = await target.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: testInfo.outputPath("room-tabs-390.png"),
    fullPage: true,
    animations: "disabled",
  });
  // Two rooms chosen: the tabs scroll so Room 3's, the one being chosen, is in sight.
  const garden = page.getByTestId("room-card-garden");
  await garden.getByRole("button", { name: "Select for Room 1" }).click();
  await garden.getByRole("button", { name: "Select for Room 2" }).click();
  await expectChoosing(page, 3, 3);
  await expect(page.getByTestId("room-tab-3")).toBeInViewport({ ratio: 1 });
  await assertHealthy();
});

test("shows no room tabs for one room and keeps the sort right of the heading", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingApis(page);
  await mockGroup(page, []);
  await openHotelPage(page, "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=2");
  await expect(page.getByTestId("select-rate-garden")).toBeVisible();
  await expect(page.getByTestId("room-tabs")).toHaveCount(0);
  await expect(page.getByTestId("rooms-help")).toHaveCount(0);
  const sort = page.getByRole("combobox", { name: "Sort by" });
  const right = await page
    .locator("#rooms")
    .evaluate(
      (rooms) =>
        rooms.getBoundingClientRect().right - parseFloat(getComputedStyle(rooms).paddingRight),
    );
  const select = await sort.boundingBox();
  expect(Math.abs(select!.x + select!.width - right)).toBeLessThan(2);
  // It still sorts.
  await sort.selectOption("priceHigh");
  await expect.poll(() => cardOrder(page).then((order) => order[0])).toBe("room-card-deluxe");
  await sort.selectOption("priceLow");
  await expect.poll(() => cardOrder(page).then((order) => order[0])).toBe("room-card-garden");
  await assertHealthy();
});
