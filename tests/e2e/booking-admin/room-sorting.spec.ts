import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";

// VAY-2449: Settings › Room Sorting.
const roomSorting = `/api/booking/properties/${BOOKING_ADMIN_PROPERTY_ID}/room-sorting`;
const defaults = {
  enabled: true,
  hideWithOneRoom: true,
  options: [
    { key: "recommended", enabled: true },
    { key: "priceLow", enabled: true },
    { key: "priceHigh", enabled: true },
    { key: "roomSize", enabled: true },
    { key: "capacity", enabled: false },
    { key: "bestDeal", enabled: false },
  ],
  defaultOption: "recommended",
};

async function setup(page: Page, { canSave = true, getStatus = 200, putStatus = 200 } = {}) {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const state = { sorting: structuredClone(defaults), saves: [] as unknown[] };
  // The API is another origin: the browser asks first (OPTIONS) and needs CORS headers.
  await page.route(`**${roomSorting}`, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return fulfillCorsPreflight(route);
    const headers = corsHeaders(route);
    if (method === "PUT") {
      const body = route.request().postDataJSON() as typeof defaults;
      state.saves.push(body);
      if (putStatus !== 200)
        return route.fulfill({
          status: putStatus,
          headers,
          json: { code: "booking_settings_missing" },
        });
      state.sorting = body;
      return route.fulfill({ headers, json: { sorting: body } });
    }
    if (getStatus !== 200)
      return route.fulfill({ status: getStatus, headers, json: { code: "forbidden" } });
    return route.fulfill({
      headers,
      json: { sorting: state.sorting, defaults, canSave },
    });
  });
  return state;
}

const optionNames = (page: Page) => page.getByTestId("room-sort-name").allTextContents();

test("opens from Settings and saves the hotel's own sort menu", async ({ page }, testInfo) => {
  const state = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Room Sorting/ })
    .click();
  await expect(page).toHaveURL(/\/settings\/room-sorting$/);
  await expect(page.getByRole("heading", { name: "Room Sorting", level: 1 })).toBeVisible();
  const main = page.getByRole("switch", { name: "Room Sorting" });
  await expect(main).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("switch", { name: "Hide when there is only one room" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("4 of 6 shown to guests")).toBeVisible();
  expect(await optionNames(page)).toEqual([
    "Recommended",
    "Price: Low to High",
    "Price: High to Low",
    "Room size: Largest first",
    "Capacity: Most guests first",
    "Best deal first",
  ]);
  const option = (key: string) => page.getByTestId(`room-sort-option-${key}`);
  await expect(option("recommended")).toContainText("Default");
  // Hidden options can't be the default.
  await expect(option("bestDeal").getByRole("radio")).toBeDisabled();

  // Show Best deal, make it the default and move it to the top with the keyboard.
  await option("bestDeal").getByRole("checkbox").check();
  await expect(page.getByText("5 of 6 shown to guests")).toBeVisible();
  await page.getByRole("radio", { name: "Set Best deal first as default" }).check();
  await expect(option("bestDeal")).toContainText("Default");
  const up = page.getByRole("button", { name: "Move Best deal first up" });
  for (let i = 0; i < 5; i++) await up.click();
  expect((await optionNames(page))[0]).toBe("Best deal first");
  await expect(up).toBeDisabled();
  await expect(page.getByText("Best deal first moved to position 1 of 6")).toBeAttached();
  // Hiding the default moves it to the first option still shown.
  await option("bestDeal").getByRole("checkbox").uncheck();
  await expect(option("recommended")).toContainText("Default");
  await option("bestDeal").getByRole("checkbox").check();
  await page.getByRole("radio", { name: "Set Best deal first as default" }).check();
  await page.getByRole("switch", { name: "Hide when there is only one room" }).click();

  // The preview shows the guest's menu as it opens: the shown options, the default ticked.
  const preview = page.getByTestId("room-sorting-preview");
  await expect(preview.getByTestId("room-sorting-preview-menu").getByRole("listitem")).toHaveText([
    "Best deal first",
    "Recommended",
    "Price: Low to High",
    "Price: High to Low",
    "Room size: Largest first",
  ]);
  await expect(
    preview.getByRole("listitem").filter({ hasText: "Deluxe Double" }).first(),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("room-sorting-1440.png"), fullPage: true });

  await page.getByRole("button", { name: "Save Sorting" }).click();
  await expect(page.getByText("Sorting saved")).toBeVisible();
  expect(state.saves).toEqual([
    {
      enabled: true,
      hideWithOneRoom: false,
      options: [
        { key: "bestDeal", enabled: true },
        { key: "recommended", enabled: true },
        { key: "priceLow", enabled: true },
        { key: "priceHigh", enabled: true },
        { key: "roomSize", enabled: true },
        { key: "capacity", enabled: false },
      ],
      defaultOption: "bestDeal",
    },
  ]);

  // Reset to defaults only changes the form until it is saved.
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  expect((await optionNames(page))[0]).toBe("Recommended");
  await expect(page.getByText("4 of 6 shown to guests")).toBeVisible();
  expect(state.saves).toHaveLength(1);
});

test("reorders by dragging a row's handle", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/room-sorting");
  await page
    .getByTestId("room-sort-handle-roomSize")
    .dragTo(page.getByTestId("room-sort-option-recommended"));
  await expect
    .poll(() => optionNames(page))
    .toEqual([
      "Room size: Largest first",
      "Recommended",
      "Price: Low to High",
      "Price: High to Low",
      "Capacity: Most guests first",
      "Best deal first",
    ]);
});

test("keeps the last option shown, and dims the options while sorting is off", async ({ page }) => {
  await setup(page);
  await page.goto("/settings/room-sorting");
  const option = (key: string) => page.getByTestId(`room-sort-option-${key}`);
  for (const key of ["priceLow", "priceHigh", "roomSize"])
    await option(key).getByRole("checkbox").uncheck();
  await expect(page.getByText("1 of 6 shown to guests")).toBeVisible();
  await expect(option("recommended").getByRole("checkbox")).toBeDisabled();
  const preview = page.getByTestId("room-sorting-preview");
  await expect(preview).toContainText(
    "No sort menu: guests see the rooms sorted by “Recommended”.",
  );

  await page.getByRole("switch", { name: "Room Sorting" }).click();
  await expect(preview).toContainText("No sort menu: guests see the rooms in your order.");
  await expect(
    page.getByRole("switch", { name: "Hide when there is only one room" }),
  ).toBeDisabled();
  await expect(option("priceLow").getByRole("checkbox")).toBeDisabled();
});

test("works on a phone with 44px targets", async ({ page }, testInfo) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/room-sorting");
  await expect(page.getByText("4 of 6 shown to guests")).toBeVisible();
  for (const target of [
    page.getByTestId("room-sort-option-priceLow").locator("label").last(),
    page.getByRole("button", { name: "Save Sorting" }),
    page.getByRole("button", { name: "Reset to defaults" }),
    page.getByRole("button", { name: "One room" }),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // On a phone the default sits below the option's name, never squeezing it.
  const [name, radio] = await Promise.all([
    page.getByTestId("room-sort-option-priceLow").getByTestId("room-sort-name").boundingBox(),
    page.getByRole("radio", { name: "Set Price: Low to High as default" }).boundingBox(),
  ]);
  expect(radio!.y).toBeGreaterThan(name!.y + name!.height);
  // No sideways scrolling: name anything that sticks out.
  const overflow = await page.getByRole("main").evaluate((main) => {
    const right = main.getBoundingClientRect().right;
    return Array.from(main.querySelectorAll("*"))
      .filter((el) => el.getBoundingClientRect().right > right + 1)
      .slice(0, 5)
      .map((el) => `${el.tagName}.${el.getAttribute("class") ?? ""}`.slice(0, 120));
  });
  expect(overflow).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("room-sorting-390.png"), fullPage: true });
});

test("keeps the edits when a save fails, and stops offering Save without booking settings", async ({
  page,
}) => {
  const state = await setup(page, { putStatus: 409 });
  await page.goto("/settings/room-sorting");
  await page.getByTestId("room-sort-option-capacity").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save Sorting" }).click();
  await expect(page.getByText("We couldn't save the sorting. Please try again.")).toBeVisible();
  await expect(page.getByText("5 of 6 shown to guests")).toBeVisible();
  await expect(
    page.getByText("Set up the booking engine before choosing how guests sort rooms."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Sorting" })).toBeDisabled();
  expect(state.saves).toHaveLength(1);
});

test("says when the hotel can't save yet, and when the member can't manage it", async ({
  page,
}) => {
  await setup(page, { canSave: false });
  await page.goto("/settings/room-sorting");
  await expect(
    page.getByText("Set up the booking engine before choosing how guests sort rooms."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Sorting" })).toBeDisabled();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setup(page, { getStatus: 403 });
  await page.goto("/settings/room-sorting");
  await expect(
    page.getByText("Only members who manage booking settings can change Room Sorting."),
  ).toBeVisible();
});
