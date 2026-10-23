import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_ADDON_ITEMS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";

test("shared editor validates, uploads five photos, changes cover, removes and reopens", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const noLegacy = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");
  await mockBookingAdminBookingFlow(page);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://addon-photos.test/**", (route) =>
    route.fulfill({ contentType: "image/png", body: png }),
  );
  let uploads = 0;
  await page.route("**/api/media/upload-sessions", async (route) => {
    expect(route.request().postDataJSON().purpose).toBe("booking.addon.image");
    uploads++;
    await route.fulfill({
      json: {
        uploadSession: { sessionId: String(uploads), status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: String(uploads),
            uploadUrl: "https://uploads.vayada.localhost/test",
            method: "PUT",
            headers: {},
          },
        ],
      },
    });
  });
  await page.route("**/api/media/upload-sessions/*/finalize", async (route) => {
    const index = route.request().url().split("/").at(-2);
    await route.fulfill({
      json: {
        mediaObjects: [
          {
            mediaId: `d3000000-0000-4000-8000-00000000068${index}`,
            variants: [{ publicCdnUrl: `https://addon-photos.test/${index}.png` }],
          },
        ],
      },
    });
  });
  let items: Record<string, unknown>[] = [];
  await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, async (route) => {
    const method = route.request().method();
    if (method === "GET")
      return route.fulfill({
        json: {
          addonItems: items,
          propertyCurrency: "EUR",
          propertyPlan: { plan: "fixed", limits: { maxAddons: 9 } },
        },
      });
    const body = route.request().postDataJSON();
    const photos = body.photos.map((photo: { mediaObjectId: string; isCover: boolean }) => ({
      ...photo,
      imageUrl: `https://addon-photos.test/${photo.mediaObjectId.slice(-1)}.png`,
    }));
    const cover = photos.find((photo: { isCover: boolean }) => photo.isCover);
    items = [
      {
        ...body,
        photos,
        imageUrl: cover?.imageUrl ?? null,
        imageMediaObjectId: cover?.mediaObjectId ?? null,
        addonItemId: "breakfast",
        sortOrder: 0,
      },
    ];
    await route.fulfill({ status: method === "POST" ? 201 : 200, json: items[0] });
  });
  await page.goto("/add-ons");
  await page.getByRole("button", { name: "New add-on" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New add-on" })).toBeVisible();
  // VAY-2231: the preview is the booking page's own card.
  await expect(dialog.locator("article", { hasText: "Untitled add-on" })).toBeVisible();
  await dialog.getByRole("button", { name: "Create add-on", exact: true }).click();
  await expect(dialog.getByText("Name is required.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create add-on", exact: true })).toBeEnabled();
  await dialog.getByLabel(/^Name \*/).fill("Breakfast");
  await dialog.getByRole("radio", { name: "Food & Beverage" }).check();
  await dialog.getByRole("radio", { name: /^Per person × night/ }).check();
  await dialog.getByLabel(/^Price per guest per night \(EUR\) \*/).fill("15.00");
  // 2 guests × 3 nights × €15.00 in the price example, and the preview follows the form.
  await expect(dialog.getByText(/Example: 2 guests, 3 nights → €90\.00 total/)).toBeVisible();
  await expect(dialog.getByText("/ person / night", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Max quantity", { exact: true })).toBeHidden();
  await dialog.getByText("More options", { exact: true }).click();
  await dialog.getByLabel("Max quantity", { exact: true }).fill("2");
  // VAY-2232: the lead time is a fixed choice, and the preview shows the guests' notice.
  const leadTime = dialog.getByLabel("Lead time", { exact: true });
  await expect(leadTime.locator("option")).toHaveText([
    "No lead time",
    "12 hours",
    "24 hours",
    "2 days",
    "3 days",
    "1 week",
  ]);
  await leadTime.selectOption({ label: "24 hours" });
  // VAY-2231: the notice shows in the details guests open.
  await dialog.getByRole("button", { name: "Detail view" }).click();
  await expect(dialog.getByText("Needs 24 hours’ notice")).toBeVisible();
  await leadTime.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("addon-editor-lead-time.png") });
  await dialog.getByLabel("Add photos", { exact: true }).setInputFiles(
    Array.from({ length: 5 }, (_, i) => ({
      name: `photo-${i}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(dialog.getByLabel("Add photos", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Set photo 3 as cover", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("addon-editor-five-photos.png") });
  await dialog.getByRole("button", { name: "Create add-on", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(uploads).toBe(5);
  expect(items[0]).toMatchObject({
    category: "dining",
    currency: "EUR",
    pricingModel: "per_guest_night",
    maxQuantity: 2,
    leadTimeHours: 24,
  });
  expect(items[0]).not.toHaveProperty("leadTime");
  await expect(page.getByText("Needs 24 hours’ notice")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("addon-list-lead-time.png") });
  await page.getByRole("button", { name: "Edit Breakfast", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Set photo 3 as cover", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Remove photo 2", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Edit Breakfast", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^Set photo/ })).toHaveCount(4);
  await expect(
    dialog.getByRole("button", { name: "Set photo 2 as cover", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await noLegacy();
});

test("keeps a lead time typed as text until a choice replaces it (VAY-2232)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mockBookingAdminBookingFlow(page);
  const transfer = {
    addonItemId: "transfer",
    hotelId: "hotel",
    propertyId: "d3000000-0000-4000-8000-000000000682",
    name: "Airport transfer",
    description: "",
    price: "30.00",
    currency: "EUR",
    category: "transport",
    imageUrl: null,
    imageMediaObjectId: null,
    photos: [],
    duration: null,
    location: null,
    maxGuests: null,
    maxQuantity: 1,
    leadTimeHours: null,
    leadTime: "10h",
    pricingModel: "per_stay",
    publicVisible: true,
    status: "active",
    sortOrder: 0,
    ownershipKind: "property",
    partnerCommissionRate: null,
  };
  const patches: Record<string, unknown>[] = [];
  await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          addonItems: [transfer],
          propertyCurrency: "EUR",
          propertyPlan: { plan: "fixed", limits: { maxAddons: 9 } },
        },
      });
    const body = route.request().postDataJSON();
    patches.push(body);
    // A copy is a new add-on; an edit answers with the saved add-on.
    const copy = route.request().method() === "POST" ? { addonItemId: "transfer-copy" } : {};
    return route.fulfill({ json: { ...transfer, ...body, ...copy } });
  });
  await page.goto("/add-ons");
  await expect(page.getByText("10h", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Airport transfer", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // The typed text shows as the current, not selectable, value.
  await expect(
    dialog.getByLabel("Lead time", { exact: true }).locator("option:checked"),
  ).toHaveText("10h (typed earlier)");
  await dialog.getByLabel(/^Price per booking \(EUR\) \*/).fill("35.00");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // Saving another field leaves the old text for the data migration to convert.
  expect(patches[0]).toMatchObject({ price: "35.00" });
  expect(patches[0]).not.toHaveProperty("leadTimeHours");
  expect(patches[0]).not.toHaveProperty("leadTime");
  // A copy keeps it too, instead of being bookable without notice.
  await page.getByRole("button", { name: "Duplicate Airport transfer", exact: true }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toMatchObject({ leadTime: "10h", publicVisible: false });
  expect(patches[1]).not.toHaveProperty("leadTimeHours");
  patches.splice(0);
  await page.getByRole("button", { name: "Edit Airport transfer", exact: true }).click();
  await dialog.getByText("More options", { exact: true }).click();
  await dialog.getByLabel("Lead time", { exact: true }).selectOption({ label: "12 hours" });
  await dialog.getByRole("button", { name: "Detail view" }).click();
  await expect(dialog.getByText("Needs 12 hours’ notice")).toBeVisible();
  await dialog.getByLabel("Lead time", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("addon-editor-after.png") });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(patches[0]).toMatchObject({ leadTimeHours: 12 });
  await expect(page.getByText("Needs 12 hours’ notice")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("addon-list-after.png") });
});

// VAY-2231: the eye button shows a saved add-on's details as guests see them.
for (const width of [1440, 390]) {
  test(`previews an add-on as guests see it from the list at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width > 400 ? 1000 : 844 });
    await mockBookingAdminBookingFlow(page);
    await page.goto("/add-ons");
    await page.getByRole("button", { name: "Preview Airport transfer as guests see it" }).click();
    const preview = page.getByRole("dialog", { name: "Guest preview · Airport transfer" });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Transport");
    await expect(preview).toContainText("45 min");
    await expect(preview).toContainText("Private pickup from the airport.");
    await expect(preview).toContainText("€45");
    await page.screenshot({ path: testInfo.outputPath(`addon-guest-preview-${width}.png`) });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await preview.getByRole("button", { name: "Done" }).click();
    await expect(preview).toBeHidden();
    await page.getByRole("button", { name: "Preview Airport transfer as guests see it" }).click();
    await preview.getByRole("button", { name: "Edit add-on" }).click();
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "Edit add-on" }),
    ).toBeVisible();
  });
}
