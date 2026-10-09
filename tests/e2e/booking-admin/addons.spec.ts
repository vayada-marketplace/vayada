import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_ADDON_ITEMS_PATH,
  BOOKING_ADMIN_ADDON_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin add-ons settings cutover", () => {
  test("loads and saves display settings through the TypeScript contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");

    await mockBookingAdminBookingFlow(page);

    const contractRequests: string[] = [];
    const itemContractRequests: Array<{ method: string; pathname: string }> = [];
    const typedItemWrites: Array<{ method: string; pathname: string; body?: unknown }> = [];
    const typedWrites: unknown[] = [];
    const propertyPlan = {
      propertyId: "property_alpenrose",
      plan: "commission" as const,
      limits: {
        maxRoomPhotosPerType: 10,
        maxAddons: 3,
        guestContactAccess: "after_acceptance" as const,
      },
    };
    let addonItems = [
      {
        addonItemId: "addon_airport_transfer",
        hotelId: BOOKING_ADMIN_HOTEL_ID,
        propertyId: "property_alpenrose",
        name: "Airport transfer",
        description: "Private pickup from the airport.",
        price: "45.00",
        currency: "EUR",
        category: "transport",
        imageUrl: null,
        duration: "45 min",
        pricingModel: "per_stay",
        publicVisible: true,
        status: "active",
        sortOrder: 0,
        ownershipKind: "property",
        partnerCommissionRate: null,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
      {
        addonItemId: "addon_breakfast_basket",
        hotelId: BOOKING_ADMIN_HOTEL_ID,
        propertyId: "property_alpenrose",
        name: "Breakfast basket",
        description: "A prepared breakfast delivered to the room.",
        price: "28.00",
        currency: "EUR",
        category: "dining",
        imageUrl: null,
        duration: null,
        pricingModel: "per_guest",
        publicVisible: true,
        status: "active",
        sortOrder: 1,
        ownershipKind: "property",
        partnerCommissionRate: null,
        createdAt: "2026-06-01T10:02:00.000Z",
        updatedAt: "2026-06-01T10:02:00.000Z",
      },
    ];
    let failFirstItemsRead = true;
    await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      itemContractRequests.push({ method: request.method(), pathname });
      if (request.method() === "GET" && failFirstItemsRead) {
        failFirstItemsRead = false;
        await route.fulfill({ status: 503, json: { message: "Add-ons unavailable." } });
        return;
      }

      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const created = {
          addonItemId: "addon_spa_ritual",
          hotelId: BOOKING_ADMIN_HOTEL_ID,
          propertyId: "property_alpenrose",
          name: body.name,
          description: body.description,
          price: body.price,
          currency: body.currency,
          category: body.category,
          imageUrl: body.imageUrl,
          duration: body.duration,
          pricingModel: body.pricingModel,
          publicVisible: body.publicVisible,
          status: body.status,
          sortOrder: body.sortOrder ?? addonItems.length,
          ownershipKind: body.ownershipKind,
          partnerCommissionRate: body.partnerCommissionRate,
          createdAt: "2026-06-01T10:05:00.000Z",
          updatedAt: "2026-06-01T10:05:00.000Z",
        };
        typedItemWrites.push({ method: "POST", pathname, body });
        addonItems = [...addonItems, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }

      if (request.method() === "PATCH") {
        const body = request.postDataJSON();
        const addonItemId = pathname.split("/").pop();
        const updatedAt = "2026-06-01T10:10:00.000Z";
        const updated = addonItems
          .filter((item) => item.addonItemId === addonItemId)
          .map((item) => ({ ...item, ...body, updatedAt }))[0];
        typedItemWrites.push({ method: "PATCH", pathname, body });
        addonItems = addonItems.map((item) =>
          item.addonItemId === addonItemId ? (updated ?? item) : item,
        );
        await route.fulfill({ json: updated });
        return;
      }

      if (request.method() === "DELETE") {
        const addonItemId = pathname.split("/").pop();
        typedItemWrites.push({ method: "DELETE", pathname });
        addonItems = addonItems.filter((item) => item.addonItemId !== addonItemId);
        await route.fulfill({ status: 204 });
        return;
      }

      expect(request.method()).toBe("GET");
      await route.fulfill({ json: { addonItems, propertyPlan, propertyCurrency: "EUR" } });
    });
    await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        typedWrites.push(body);
        await route.fulfill({ json: body });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: false },
      });
    });

    // Add-ons left Booking Flow for its own page (VAY-2077); old tab links still land there.
    await page.goto("/booking-flow?tab=addons");
    await expect(page).toHaveURL(/\/add-ons$/);
    // A failed read shows Retry instead of an empty list and default display settings.
    await expect(
      page.getByRole("alert").filter({ hasText: "Failed to load settings" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    const addonNames = page.getByTestId("booking-addon-item-name");
    await expect(addonNames).toHaveText(["Airport transfer", "Breakfast basket"]);

    await page
      .getByRole("button", { name: "Drag Airport transfer" })
      .dragTo(page.getByTestId("booking-addon-item-addon_breakfast_basket"));

    await expect(addonNames).toHaveText(["Breakfast basket", "Airport transfer"]);

    await page.getByRole("button", { name: "New add-on" }).click();
    await page.getByLabel("Name").fill("Spa ritual");
    await page.getByLabel("Description").fill("Private treatment.");
    await page.getByLabel(/^Price per/).fill("125.50");
    await page.getByRole("radio", { name: "Wellness" }).check();
    await page.getByText("More options", { exact: true }).click();
    await page.getByLabel("Duration").fill("90 min");
    await page.getByRole("radio", { name: "Per person", exact: true }).check();
    await page.getByLabel("Ownership").selectOption("partner");
    await page.getByRole("button", { name: "Create Add-on" }).click();
    expect(typedItemWrites.filter((write) => write.method === "POST")).toHaveLength(0);
    await page.getByLabel("Partner commission (%)").fill("12.5000");
    await page.getByRole("button", { name: "Create Add-on" }).click();
    await expect(page.getByText("Spa ritual")).toBeVisible();
    await expect(page.getByText("Partner · 12.5000%")).toBeVisible();

    await page.getByRole("button", { name: "Edit Spa ritual" }).click();
    await page.getByLabel("Name").fill("Spa ritual deluxe");
    await page.getByLabel("Ownership").selectOption("property");
    await expect(page.getByLabel("Partner commission (%)")).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Spa ritual deluxe")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete Spa ritual deluxe" }).click();
    await expect(page.getByText("Spa ritual deluxe")).not.toBeVisible();

    await expect(page.getByRole("heading", { name: "Display Settings" })).toBeVisible();
    await expect(page.getByRole("switch", { name: /Show Add-ons Step/ })).toBeVisible();

    const groupToggle = page.getByRole("switch", { name: /Group by Category/ });
    await expect(groupToggle).toBeVisible();
    await groupToggle.click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(itemContractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_ADDON_SETTINGS_PATH);
    expect(itemContractRequests[0]).toEqual({
      method: "GET",
      pathname: BOOKING_ADMIN_ADDON_ITEMS_PATH,
    });
    const reorderWrites = typedItemWrites.filter(
      (write) =>
        write.method === "PATCH" &&
        typeof write.body === "object" &&
        write.body !== null &&
        "sortOrder" in write.body,
    );
    expect(reorderWrites).toEqual(
      expect.arrayContaining([
        {
          method: "PATCH",
          pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_airport_transfer`,
          body: { sortOrder: 1 },
        },
        {
          method: "PATCH",
          pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_breakfast_basket`,
          body: { sortOrder: 0 },
        },
      ]),
    );

    const nonReorderWrites = typedItemWrites.filter((write) => !reorderWrites.includes(write));
    expect(nonReorderWrites).toEqual([
      {
        method: "POST",
        pathname: BOOKING_ADMIN_ADDON_ITEMS_PATH,
        body: {
          name: "Spa ritual",
          description: "Private treatment.",
          price: "125.50",
          currency: "EUR",
          category: "wellness",
          photos: [],
          leadTime: null,
          location: null,
          maxGuests: null,
          maxQuantity: 1,
          duration: "90 min",
          pricingModel: "per_guest",
          publicVisible: true,
          status: "active",
          sortOrder: 2,
          ownershipKind: "partner",
          partnerCommissionRate: "12.5000",
        },
      },
      {
        method: "PATCH",
        pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_spa_ritual`,
        body: {
          name: "Spa ritual deluxe",
          description: "Private treatment.",
          price: "125.50",
          currency: "EUR",
          category: "wellness",
          photos: [],
          leadTime: null,
          location: null,
          maxGuests: null,
          maxQuantity: 1,
          duration: "90 min",
          pricingModel: "per_guest",
          ownershipKind: "property",
          partnerCommissionRate: null,
        },
      },
      {
        method: "DELETE",
        pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_spa_ritual`,
      },
    ]);
    expect(typedWrites).toEqual([{ showAddonsStep: true, groupAddonsByCategory: true }]);

    await assertNoLegacyCalls();
    await assertHealthy();
  });
  test("searches, filters, hides and duplicates add-ons in the list", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminBookingFlow(page);
    const base = {
      hotelId: BOOKING_ADMIN_HOTEL_ID,
      propertyId: "property_alpenrose",
      currency: "EUR",
      imageUrl: null,
      ownershipKind: "property",
      partnerCommissionRate: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    };
    let addonItems: Array<Record<string, unknown>> = [
      {
        ...base,
        addonItemId: "addon_breakfast",
        name: "Balinese breakfast",
        description: "Fresh fruit, eggs any style, coffee or tea.",
        price: "12.00",
        category: "dining",
        duration: "90 min",
        maxQuantity: 6,
        pricingModel: "per_guest_night",
        publicVisible: true,
        status: "active",
        sortOrder: 0,
        photos: [
          { mediaObjectId: "media-1", imageUrl: "https://cdn.example/1.jpg", isCover: true },
          { mediaObjectId: null, imageUrl: "https://legacy.example/2.jpg", isCover: false },
        ],
      },
      {
        ...base,
        addonItemId: "addon_massage",
        name: "In-villa massage",
        description: "Traditional massage by our resident therapist.",
        price: "35.00",
        category: "wellness",
        duration: "60 min",
        maxQuantity: 4,
        pricingModel: "per_guest",
        publicVisible: false,
        status: "active",
        sortOrder: 1,
      },
    ];
    const writes: Array<{ method: string; pathname: string; body: unknown }> = [];
    await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "GET") {
        await route.fulfill({
          json: {
            addonItems,
            propertyCurrency: "EUR",
            propertyPlan: {
              propertyId: "property_alpenrose",
              plan: "fixed",
              limits: { maxRoomPhotosPerType: 10, maxAddons: 9, guestContactAccess: "always" },
            },
          },
        });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), pathname, body });
      if (request.method() === "POST") {
        const created = { ...base, ...body, addonItemId: "addon_copy" };
        addonItems = [...addonItems, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }
      const addonItemId = pathname.split("/").pop();
      addonItems = addonItems.map((item) =>
        item.addonItemId === addonItemId ? { ...item, ...body } : item,
      );
      await route.fulfill({ json: addonItems.find((item) => item.addonItemId === addonItemId) });
    });

    await page.goto("/add-ons");
    await expect(page.getByRole("heading", { name: "Add-ons", exact: true })).toBeVisible();
    await expect(
      page.getByText("2 add-ons · 1 live on your booking engine · prices in EUR"),
    ).toBeVisible();
    const names = page.getByTestId("booking-addon-item-name");
    await expect(names).toHaveText(["Balinese breakfast", "In-villa massage"]);
    const breakfast = page.getByTestId("booking-addon-item-addon_breakfast");
    await expect(breakfast.getByText("2 photos")).toBeVisible();
    await expect(breakfast.getByText("Food & Beverage")).toBeVisible();
    await expect(breakfast.getByText("Per person × night")).toBeVisible();
    await expect(breakfast.getByText("Max 6/booking")).toBeVisible();
    await expect(
      page.getByTestId("booking-addon-item-addon_massage").getByText("Hidden", { exact: true }),
    ).toBeVisible();
    for (const [width, height, name] of [
      [1440, 900, "desktop"],
      [820, 1180, "tablet"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await testInfo.attach(`addons-list-${name}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByPlaceholder("Search add-ons").fill("massage");
    await expect(names).toHaveText(["In-villa massage"]);
    await page.getByPlaceholder("Search add-ons").fill("");
    await page.getByRole("button", { name: "Food & Beverage", exact: true }).click();
    await expect(names).toHaveText(["Balinese breakfast"]);
    await page.getByRole("button", { name: "All", exact: true }).click();

    await page
      .getByRole("switch", { name: "Show In-villa massage on your booking engine" })
      .click();
    await expect(
      page.getByRole("switch", { name: "Show In-villa massage on your booking engine" }),
    ).toHaveAttribute("aria-checked", "true");
    await page
      .getByRole("switch", { name: "Show Balinese breakfast on your booking engine" })
      .click();
    await expect(
      page.getByText("2 add-ons · 1 live on your booking engine · prices in EUR"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Duplicate Balinese breakfast" }).click();
    await expect(names).toHaveText([
      "Balinese breakfast",
      "In-villa massage",
      "Balinese breakfast (copy)",
    ]);
    // The copy stays off the booking engine until the host edits and shows it.
    await expect(
      page.getByTestId("booking-addon-item-addon_copy").getByText("Hidden", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("3 add-ons · 1 live on your booking engine · prices in EUR"),
    ).toBeVisible();
    expect(writes.slice(0, 2)).toEqual([
      {
        method: "PATCH",
        pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_massage`,
        body: { publicVisible: true, status: "active" },
      },
      {
        method: "PATCH",
        pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_breakfast`,
        body: { publicVisible: false },
      },
    ]);
    expect(writes[2]).toMatchObject({
      method: "POST",
      body: {
        name: "Balinese breakfast (copy)",
        price: "12.00",
        category: "dining",
        pricingModel: "per_guest_night",
        maxQuantity: 6,
        duration: "90 min",
        publicVisible: false,
        // Imported photos without a media object can't be copied to a new add-on.
        photos: [
          { mediaObjectId: "media-1", imageUrl: "https://cdn.example/1.jpg", isCover: true },
        ],
      },
    });
    await assertHealthy();
  });
});
