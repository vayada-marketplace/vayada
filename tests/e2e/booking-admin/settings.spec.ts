import { expect, test, type Page } from "@playwright/test";
import { stripeOnboardingPropertyKey } from "../../../apps/booking-admin/lib/utils/stripeOnboardingRefresh";
import {
  BOOKING_ADMIN_BOOKING_DESIGN_PATH,
  BOOKING_ADMIN_CUSTOM_DOMAIN_PATH,
  BOOKING_ADMIN_DESIGN_SETTINGS_PATH,
  BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH,
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  BOOKING_ADMIN_PROPERTY_SETTINGS_PATH,
  BOOKING_ADMIN_SAME_DAY_PATH,
  BOOKING_ADMIN_PROPERTY_PROFILE_PATH,
  BOOKING_ADMIN_PUBLIC_BOOKABILITY_PATH,
  BOOKING_ADMIN_PUBLIC_PROPERTY_PROFILE_PATH,
  defaultBookingAdminPropertyProfile,
  defaultBookingAdminPublicPropertyProfile,
  defaultBookingAdminDesignSettings,
  defaultBookingAdminPropertySettings,
  defaultCustomDomain,
  mockBookingAdminDesignSettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
  type BookingAdminCustomDomainFixture,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin settings no-legacy guard", () => {
  test("loads and saves the shared same-day booking cutoff", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    let failRead = true;
    let failWrite = false;
    await page.route(`**${BOOKING_ADMIN_SAME_DAY_PATH}*`, async (route) => {
      if (route.request().method() === "GET" && failRead) {
        failRead = false;
        await route.fulfill({ status: 503, json: { message: "Same-day settings unavailable." } });
        return;
      }
      if (route.request().method() === "PUT" && failWrite) {
        await route.fulfill({
          status: 503,
          json: { message: "Same-day settings were not saved." },
        });
        return;
      }
      await route.fallback();
    });
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: false,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: null,
              provider: null,
              status: "not_configured",
              onboardingStatus: "not_started",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      }),
    );

    await page.goto("/settings/booking-rules");

    await expect(
      page.getByRole("alert").filter({ hasText: "Same-day booking settings failed to load." }),
    ).toBeVisible();
    await expect(page.getByRole("switch", { name: "Allow same-day bookings" })).toHaveCount(0);
    await expect(page.getByLabel("Same-day booking cutoff")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("switch", { name: "Allow same-day bookings" })).toBeChecked();
    const assertHealthy = watchPageHealth(page, testInfo);
    const cutoff = page.getByLabel("Same-day booking cutoff");
    await expect(cutoff).toHaveValue("18:00");
    await expect(page.getByText(/property timezone \(Europe\/Vienna\)/)).toBeVisible();
    const sameDayWrite = page.waitForRequest(
      (request) => request.method() === "PUT" && request.url().endsWith("/same-day-booking"),
    );
    await cutoff.selectOption("17:30");
    const body = (await sameDayWrite).postDataJSON();
    expect(body).toMatchObject({ enabled: true, cutoffLocalTime: "17:30" });
    expect(body.idempotencyKey).toBe(body.commandId);
    const success = page.getByText("Same-day booking settings saved.");
    await expect(success).toBeVisible();
    await assertNoLegacyCalls();
    await assertHealthy();

    failWrite = true;
    await cutoff.selectOption("17:00");
    await expect(success).toHaveCount(0);
    await expect(
      page.getByRole("alert").filter({ hasText: "Same-day booking settings could not be saved." }),
    ).toBeVisible();
    await assertNoLegacyCalls();
  });

  test("shows onboarding social links in Property settings and keeps all four editable", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    const persisted = {
      ...defaultBookingAdminPropertySettings,
      property_name: "Alpenrose",
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "https://youtube.com/@alpenrose",
    };
    await mockBookingAdminShellRoutes(page, { propertySettings: persisted });
    const writes: unknown[] = [];
    await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        writes.push(body);
        Object.assign(persisted, body);
      }
      await route.fulfill({ json: persisted });
    });

    await page.goto("/settings/general");

    await expect(page.getByPlaceholder("https://instagram.com/yourhotel")).toHaveValue(
      "https://instagram.com/alpenrose",
    );
    await expect(page.getByPlaceholder("https://facebook.com/yourhotel")).toHaveValue(
      "https://facebook.com/alpenrose",
    );
    await expect(page.getByPlaceholder("https://www.tiktok.com/@yourhotel")).toHaveValue(
      "https://tiktok.com/@alpenrose",
    );
    await expect(page.getByPlaceholder("https://youtube.com/@yourhotel")).toHaveValue(
      "https://youtube.com/@alpenrose",
    );

    await page
      .getByPlaceholder("https://www.tiktok.com/@yourhotel")
      .fill("https://tiktok.com/@alpenrose-hotel");
    await page.getByRole("button", { name: "Save property details", exact: true }).click();

    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose-hotel",
      youtube: "https://youtube.com/@alpenrose",
    });
    await assertHealthy();
  });

  test("saves the property name through the profile and keeps the address and PayPal", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    // VAY-2101: the name and address used to be sent to a write that never stored them.
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    const persisted = {
      ...defaultBookingAdminPropertySettings,
      property_name: "Alpenrose",
      address: "Alpenstrasse 12, Munich, 80331, DE",
    };
    await mockBookingAdminShellRoutes(page, { propertySettings: persisted });
    const profile = structuredClone(defaultBookingAdminPropertyProfile);
    const profileWrites: unknown[] = [];
    let refuseRename = false;
    await page.route(`**${BOOKING_ADMIN_PROPERTY_PROFILE_PATH}*`, async (route) => {
      if (route.request().method() === "PUT" && refuseRename) {
        await route.fulfill({ status: 403, json: { code: "forbidden" } });
        return;
      }
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as {
          expectedProfileRevision: number;
          patch: { displayName: string };
        };
        profileWrites.push(body);
        profile.profileRevision += 1;
        profile.profile.displayName = body.patch.displayName;
        persisted.property_name = body.patch.displayName;
      }
      await route.fulfill({ json: profile });
    });
    const settingsWrites: Record<string, unknown>[] = [];
    await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        settingsWrites.push(body);
        Object.assign(persisted, body);
      }
      await route.fulfill({ json: persisted });
    });
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash", "paypal"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            depositPolicy: { paypalEmail: "pay@alpenrose.example", paypalPaymentWindowHours: 24 },
            providerAccount: {
              providerAccountId: null,
              provider: null,
              status: "not_configured",
              onboardingStatus: "not_started",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      }),
    );

    await page.goto("/settings/general");
    await expect(page.getByTestId("property-address")).toHaveText(
      "Alpenstrasse 12, Munich, 80331, DE",
    );
    await expect(
      page.getByRole("link", { name: "Edit in Location & surroundings" }),
    ).toHaveAttribute("href", "/settings/location");
    const name = page.getByPlaceholder("Enter property name");
    await expect(name).toHaveValue("Alpenrose");
    await name.fill("Alpenrose Lodge");
    await page.getByRole("button", { name: "Save property details", exact: true }).click();
    await expect(page.getByText("Settings saved successfully")).toBeVisible();

    expect(profileWrites).toEqual([
      { expectedProfileRevision: 1, patch: { displayName: "Alpenrose Lodge" } },
    ]);
    expect(settingsWrites).toHaveLength(1);
    for (const field of ["property_name", "address", "city", "country"]) {
      expect(settingsWrites[0]).not.toHaveProperty(field);
    }
    await page.goto("/settings/payments");
    await expect(page.getByPlaceholder("payments@yourproperty.com")).toHaveValue(
      "pay@alpenrose.example",
    );

    // The old Property link opens General again, as a fresh visit would.
    await page.goto("/settings?section=property");
    await expect(page.getByPlaceholder("Enter property name")).toHaveValue("Alpenrose Lodge");
    await assertHealthy();

    // Only the owner can rename: other changes save, and the page says the name did not.
    // (The refused request logs a console error, so page health is checked above.)
    refuseRename = true;
    await page.getByPlaceholder("Enter property name").fill("Alpenrose Hotel");
    await page.getByRole("button", { name: "Save property details", exact: true }).click();
    await expect(
      page.getByText("Your other changes were saved, but the property name wasn't changed."),
    ).toBeVisible();
    await expect(page.getByText("Settings saved successfully")).toHaveCount(0);
    expect(settingsWrites).toHaveLength(2);
    expect(profileWrites).toHaveLength(1);
  });

  test("edits the property description shown in the booking site footer", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    // VAY-2142: the footer description had no edit field in Booking Admin.
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    const persisted = { ...defaultBookingAdminPropertySettings, property_name: "Alpenrose" };
    await mockBookingAdminShellRoutes(page, { propertySettings: persisted });
    const writes: string[] = [];
    const publicProfile = structuredClone(defaultBookingAdminPublicPropertyProfile);
    const descriptionWrites: unknown[] = [];
    let failDescriptionWrite = false;
    await page.route(`**${BOOKING_ADMIN_PUBLIC_PROPERTY_PROFILE_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        if (failDescriptionWrite) {
          await route.fulfill({ status: 500, json: { message: "Unavailable" } });
          return;
        }
        const body = route.request().postDataJSON() as {
          expectedProfileRevision: number;
          patch: { shortDescription: string };
        };
        writes.push("description");
        descriptionWrites.push(body);
        publicProfile.profileRevision += 1;
        publicProfile.publicProfile.shortDescription = body.patch.shortDescription;
      }
      await route.fulfill({ json: publicProfile });
    });
    await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PATCH") writes.push("settings");
      await route.fulfill({ json: persisted });
    });
    const clientRefreshes: string[] = [];
    await page.route(`**${BOOKING_ADMIN_PUBLIC_BOOKABILITY_PATH}*`, async (route) => {
      clientRefreshes.push(route.request().url());
      await route.fallback();
    });
    const save = page.getByRole("button", { name: "Save property details", exact: true });

    await page.goto("/settings/general");
    const description = page.getByLabel("Property description");
    await expect(description).toHaveValue(
      defaultBookingAdminPublicPropertyProfile.publicProfile.shortDescription,
    );
    await expect(
      page.getByText("A short line about your property, shown in the booking site footer."),
    ).toBeVisible();

    // Setup's rule for the same text: 50 to 500 characters, checked before anything is saved.
    await description.fill("Too short.");
    await save.click();
    await expect(
      page.getByText("The property description needs 50 to 500 characters."),
    ).toBeVisible();
    expect(writes).toEqual([]);

    const text = "A family-run alpine hotel in the heart of Munich, ten minutes from the old town.";
    await description.fill(`  ${text}  `);
    await save.click();
    await expect(page.getByText("Settings saved successfully")).toBeVisible();
    expect(descriptionWrites).toEqual([
      { expectedProfileRevision: 1, patch: { shortDescription: text } },
    ]);
    // The description lands first, so the settings save's own refresh of a live booking page
    // carries it; the page sends no refresh of its own.
    expect(writes).toEqual(["description", "settings"]);
    expect(clientRefreshes).toEqual([]);
    await expect(description).toHaveValue(text);

    // Editing hides the success banner; saving without changes writes no description.
    await description.fill(`${text} `);
    await expect(page.getByText("Settings saved successfully")).toHaveCount(0);
    await save.click();
    await expect(page.getByText("Settings saved successfully")).toBeVisible();
    expect(writes).toEqual(["description", "settings", "settings"]);
    await testInfo.attach("settings-general-description", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await assertHealthy();

    // A failed description write stops the save, so nothing changes.
    // (The refused requests log console errors, so page health is checked above.)
    failDescriptionWrite = true;
    await description.fill(`${text} Breakfast is served on the terrace.`);
    await save.click();
    await expect(
      page.getByText("The property description couldn't be saved, so nothing was changed."),
    ).toBeVisible();
    expect(writes).toEqual(["description", "settings", "settings"]);

    // A failed read keeps the field locked, so a Save can never clear the text.
    await page.route(`**${BOOKING_ADMIN_PUBLIC_PROPERTY_PROFILE_PATH}*`, (route) =>
      route.fulfill({ status: 503, json: { message: "Unavailable" } }),
    );
    await page.reload();
    await expect(
      page.getByText("The description couldn't be loaded. Reload the page to edit it."),
    ).toBeVisible();
    await expect(description).toBeDisabled();
  });

  test("loads migrated settings surfaces without helper calls", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/payment-settings*`,
      (route) =>
        route.fulfill({
          json: {
            paymentSettings: {
              paymentProvider: "vayada",
              payAtPropertyEnabled: true,
              onlineCardPayment: true,
              bankTransfer: false,
            },
          },
        }),
    );
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash", "manual_card", "card"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: null,
              provider: null,
              status: "not_configured",
              onboardingStatus: "not_started",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      }),
    );
    await page.goto("/settings/booking-rules");
    await expect(page.getByRole("heading", { name: "Booking rules", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Custom Domain" })).toHaveCount(0);
    await expect(page.getByPlaceholder("booking.yourdomain.com")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Enable map view" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: '"Refer a Guest" Feature' })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Location map", exact: true })).toHaveCount(0);
    // No Notifications settings section (the header's bell is a different button, VAY-2349).
    await expect(
      page.getByRole("main").getByRole("button", { name: "Notifications", exact: true }),
    ).toHaveCount(0);

    await page.goto("/settings/payments");
    await expect(
      page.getByText("vayada Payments is not available in target checkout yet."),
    ).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("moves custom domain setup to Design Studio and updates the live preview", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page, {
      propertySettings: { ...defaultBookingAdminPropertySettings, supported_languages: ["de"] },
    });
    const { requests: designRequests } = await mockBookingAdminDesignSettings(page);
    let customDomain: BookingAdminCustomDomainFixture = defaultCustomDomain;
    await page.route(`**${BOOKING_ADMIN_CUSTOM_DOMAIN_PATH}*`, async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { domain: string };
        customDomain = {
          hotelId: BOOKING_ADMIN_HOTEL_ID,
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          configured: true,
          domain: body.domain,
          status: "pending",
          sslStatus: "pending",
          dnsRecords: [
            {
              type: "CNAME",
              name: body.domain,
              value: "custom.booking.vayada.com",
              status: "pending",
            },
          ],
          verificationErrors: [],
          checkedAt: "2026-06-22T10:00:00.000Z",
          updatedAt: "2026-06-22T10:00:00.000Z",
        };
        await route.fulfill({ json: customDomain });
        return;
      }
      if (method === "DELETE") {
        customDomain = defaultCustomDomain;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({ json: customDomain });
    });

    await page.goto("/design-studio");

    const canonicalBookingUrl = new URL(page.url()).hostname.endsWith(".localhost")
      ? `hotel-alpenrose.booking.localhost${new URL(page.url()).port ? `:${new URL(page.url()).port}` : ""}`
      : "hotel-alpenrose.booking.vayada.com";
    await expect(page.getByRole("button", { name: "Content" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Colors" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Typography" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Layout" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Domain" })).toBeVisible();

    const preview = page.getByLabel("Live booking page preview");
    const heroImageHeading = page.getByRole("heading", { name: /Hero Image/ });
    await expect(heroImageHeading).toBeVisible();
    await expect(page.getByRole("heading", { name: "Custom Domain" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Contact button" })).toBeChecked();
    // The Refer a Guest button went with the affiliate program (VAY-2263).
    await expect(page.getByRole("switch", { name: "Refer a Guest button" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Language selector" })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Currency selector" })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Currency selector" })).not.toBeChecked();
    await expect(preview).toContainText("EN");
    await page.getByRole("switch", { name: "Language selector" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("design-studio-header-two-languages.png") });

    await page.getByRole("switch", { name: "Contact button" }).click();
    await page.getByRole("switch", { name: "Language selector" }).click();
    await expect(preview).not.toContainText("Contact");
    await expect(preview).not.toContainText("EN");
    await expect(preview.getByText("EUR", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(
        () => designRequests.find((request) => request.method === "PATCH")?.body?.showContactButton,
      )
      .toBe(false);
    await expect
      .poll(
        () =>
          designRequests.find((request) => request.method === "PATCH")?.body?.showLanguageSelector,
      )
      .toBe(false);
    expect(
      designRequests.find((request) => request.method === "PATCH")?.body?.showCurrencySelector,
    ).toBe(true);

    await page.getByRole("button", { name: "Domain" }).click();
    const currentBookingUrl = page
      .getByRole("heading", { name: "Current booking URL" })
      .locator("xpath=..");
    await expect(currentBookingUrl).toBeVisible();
    await expect(page.getByRole("heading", { name: "Custom Domain" })).toBeVisible();
    await expect(heroImageHeading).toHaveCount(0);
    await expect(
      currentBookingUrl.getByText("hotel-alpenrose.booking.vayada.com", { exact: true }),
    ).toBeVisible();
    await expect(preview).toContainText(canonicalBookingUrl);

    await page.getByPlaceholder("booking.yourdomain.com").fill("book.alpenrose.example");
    await page.getByRole("button", { name: "Connect Domain" }).click();

    await expect(preview).toContainText("book.alpenrose.example");
    await expect(preview).not.toContainText(canonicalBookingUrl);
    await expect(page.getByText("custom.booking.vayada.com")).toBeVisible();

    await page.getByRole("button", { name: "Remove domain" }).click();

    await expect(page.getByPlaceholder("booking.yourdomain.com")).toBeVisible();
    await expect(preview).toContainText(canonicalBookingUrl);
    await assertHealthy();
  });

  test("greys out header selectors guests cannot see and keeps the saved choice", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    // Japanese is configurable in the admin but the guest booking site cannot render it.
    await mockBookingAdminShellRoutes(page, {
      propertySettings: { ...defaultBookingAdminPropertySettings, supported_languages: ["ja"] },
    });
    const { requests: designRequests } = await mockBookingAdminDesignSettings(page);

    await page.goto("/design-studio");
    const language = page.getByRole("switch", { name: "Language selector" });
    const currency = page.getByRole("switch", { name: "Currency selector" });
    await expect(language).toBeDisabled();
    await expect(language).not.toBeChecked();
    await expect(
      page.getByText("Hidden automatically when only one language is configured."),
    ).toBeVisible();
    await expect(currency).toBeDisabled();
    await expect(currency).not.toBeChecked();
    await expect(
      page.getByText("Hidden automatically when only one currency is configured."),
    ).toBeVisible();
    await expect(page.getByLabel("Live booking page preview")).not.toContainText("EN");
    await language.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("design-studio-header-one-language.png") });

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(() => designRequests.find((request) => request.method === "PATCH")?.body)
      .toMatchObject({ showLanguageSelector: true, showCurrencySelector: true });
    await assertHealthy();
  });

  test("offers the currency selector once the hotel adds a display currency", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page, {
      propertySettings: { ...defaultBookingAdminPropertySettings, supported_currencies: ["USD"] },
    });
    const { requests: designRequests } = await mockBookingAdminDesignSettings(page);

    await page.goto("/design-studio");
    const currency = page.getByRole("switch", { name: "Currency selector" });
    const preview = page.getByLabel("Live booking page preview");
    await expect(currency).toBeEnabled();
    await expect(currency).toBeChecked();
    await expect(preview.getByText("EUR", { exact: true })).toBeVisible();

    await currency.click();
    await expect(currency).not.toBeChecked();
    await expect(preview.getByText("EUR", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(() => designRequests.find((request) => request.method === "PATCH")?.body)
      .toMatchObject({ showCurrencySelector: false });
    await assertHealthy();
  });

  test("counts the hotel's main language with Booking's, as the live page does (VAY-2345)", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    // Booking offers German only, but the hotel profile is in English: guests can pick both.
    await mockBookingAdminShellRoutes(page, {
      propertySettings: {
        ...defaultBookingAdminPropertySettings,
        default_language: "de",
        supported_languages: [],
      },
    });
    await mockBookingAdminDesignSettings(page);

    await page.goto("/design-studio");
    const language = page.getByRole("switch", { name: "Language selector" });
    await expect(language).toBeEnabled();
    await expect(language).toBeChecked();
    // The live page opens in the hotel's main language.
    await expect(
      page.getByLabel("Live booking page preview").getByText("EN", { exact: true }),
    ).toBeVisible();
    await assertHealthy();
  });

  test("saves the brand colour and font to the booking design guests see", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    // The settings row holds an older colour; the live page uses the booking design (VAY-2318).
    const { requests, bookingDesignRequests } = await mockBookingAdminDesignSettings(page, {
      ...defaultBookingAdminDesignSettings,
      primaryColor: "#2563EB",
      fontPairing: "high-end-serif",
    });
    const order: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "PATCH" && path === BOOKING_ADMIN_DESIGN_SETTINGS_PATH)
        order.push("settings");
      if (request.method() === "PUT" && path === BOOKING_ADMIN_BOOKING_DESIGN_PATH)
        order.push("design");
      if (request.method() === "POST" && path === BOOKING_ADMIN_PUBLIC_BOOKABILITY_PATH)
        order.push("publish");
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/design-studio?tab=colors");
    const hex = page.getByRole("textbox", { name: "Primary brand color", exact: true });
    await expect(hex).toHaveValue("#0077B6");

    // A colour too light for white button text is explained and never saved.
    const tooLight = "Too light for white button text. Choose a darker shade.";
    await hex.fill("#d4a017");
    await expect(hex).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(tooLight)).toHaveCount(1);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText(tooLight)).toHaveCount(2);
    expect(order).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("design-studio-too-light.png") });
    // The Tropical Gold preset is a darker, readable gold now.
    await page.getByRole("button", { name: "Tropical Gold" }).click();
    await expect(hex).toHaveValue("#A67D12");
    await expect(hex).toHaveAttribute("aria-invalid", "false");

    await hex.fill("#5e0000");
    await page.getByRole("button", { name: "Typography" }).click();
    await page.getByRole("button", { name: /Grand Classic/ }).click();
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(page.getByText("Design settings saved successfully")).toBeVisible();
    expect(bookingDesignRequests.filter(({ method }) => method === "PUT")).toEqual([
      {
        method: "PUT",
        body: { expectedRevision: 1, primaryColor: "#5E0000", fontPairing: "grand-classic" },
      },
    ]);
    expect(requests.find(({ method }) => method === "PATCH")?.body).toMatchObject({
      primaryColor: "#5E0000",
      fontPairing: "grand-classic",
    });
    expect(order).toEqual(["settings", "design", "publish"]);
    await page.screenshot({ path: testInfo.outputPath("design-studio-brand-colour-saved.png") });

    // A second Save with nothing changed does not write a new booking design revision.
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(() => order.filter((step) => step === "publish").length).toBe(2);
    expect(order.filter((step) => step === "design")).toHaveLength(1);
    // That Save also leaves the settings row's colour and font alone.
    const patches = requests.filter(({ method }) => method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body).not.toHaveProperty("primaryColor");
    expect(patches[1]?.body).not.toHaveProperty("fontPairing");
    await assertHealthy();
  });

  test("creates the first booking design only when the colour or font changes", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: [new RegExp(`${BOOKING_ADMIN_BOOKING_DESIGN_PATH}$`)],
    });
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    // No booking design yet, and the settings row still holds the old, too-light Tropical Gold.
    const { requests, bookingDesignRequests } = await mockBookingAdminDesignSettings(
      page,
      { ...defaultBookingAdminDesignSettings, primaryColor: "#D4A017" },
      null,
    );
    const puts = () => bookingDesignRequests.filter(({ method }) => method === "PUT");

    await page.goto("/design-studio?tab=colors");
    const hex = page.getByRole("textbox", { name: "Primary brand color", exact: true });
    await expect(hex).toHaveValue("#D4A017");
    await expect(
      page.getByText("Too light for white button text. Choose a darker shade."),
    ).toBeVisible();
    // Saving the other settings works and leaves the booking design alone.
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Design settings saved successfully")).toBeVisible();
    const [patch] = requests.filter(({ method }) => method === "PATCH");
    // A hotel still on its legacy page reads its colour from the settings row: it stays.
    expect(patch?.body).not.toHaveProperty("primaryColor");
    expect(patch?.body).not.toHaveProperty("fontPairing");
    expect(puts()).toEqual([]);

    await page.getByRole("button", { name: "Ocean Blue" }).click();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(() => puts().length).toBe(1);
    expect(puts()[0]?.body).toEqual({
      expectedRevision: 0,
      primaryColor: "#0077B6",
      fontPairing: "modern-minimalist",
    });
    await expect(page.getByText("Design settings saved successfully")).toBeVisible();
    await assertHealthy();
  });

  test("opens settings pages from the card grid and redirects legacy section links", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: false,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: null,
              provider: null,
              status: "not_configured",
              onboardingStatus: "not_started",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      }),
    );

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Booking Engine Settings" })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: /^Feature Hub/ })).toHaveAttribute(
      "href",
      "/settings/feature-hub",
    );
    // Timo's card order (VAY-2144): Room Filters and Guest Form joined from Booking Flow.
    const cards: [string, string | null][] = [
      ["Booking rules", "/settings/booking-rules"],
      ["General", "/settings/general"],
      ["Payments", "/settings/payments"],
      ["Book Direct Benefits", "/settings/book-direct-benefits"],
      ["Policies", "/settings/policies"],
      ["Room Filters", "/settings/room-filters"],
      ["Guest Form", "/settings/guest-form"],
      ["Billing", "/settings/billing"],
      ["Privacy & data", "/settings/privacy"],
      ["Account", null],
    ];
    const items = main.getByRole("listitem");
    await expect(items).toHaveCount(cards.length);
    for (const [index, [card, href]] of cards.entries()) {
      await expect(items.nth(index)).toContainText(card);
      if (href) {
        await expect(items.nth(index).getByRole("link")).toHaveAttribute("href", href);
      } else {
        await expect(items.nth(index).getByRole("link")).toHaveCount(0);
        await expect(items.nth(index).getByText("Coming soon")).toBeVisible();
      }
    }
    // Email & notifications stays hidden until it has a page.
    await expect(main.getByText("Email & notifications")).toHaveCount(0);
    await testInfo.attach("settings-grid-desktop", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await main.getByRole("link", { name: /^Policies/ }).click();
    await expect(page).toHaveURL(/\/settings\/policies$/);
    await expect(page.getByRole("heading", { name: "Policies", exact: true })).toBeVisible();
    await expect(page.getByText("Terms & Conditions", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Accept bookings instantly" })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
    await expect(page).toHaveURL(/\/settings$/);

    for (const [legacy, target] of [
      ["?section=property", "/settings/general"],
      ["?section=localization", "/settings/general#localization"],
      ["?section=booking", "/settings/booking-rules"],
      ["?section=payments", "/settings/payments"],
      ["?section=billing", "/settings/billing"],
      [
        "?billing=canceled&source=email&section=payments",
        "/settings/payments?billing=canceled&source=email",
      ],
      ["?billing=canceled", "/settings/billing?billing=canceled"],
    ]) {
      await page.goto(`/settings${legacy}`, { waitUntil: "networkidle" });
      await expect(page).toHaveURL(new URL(target, page.url()).toString());
    }
    await expect(
      page.getByText("Payment failed. Please try again or use a different card."),
    ).toBeVisible();

    for (const unknown of ["unknown", "account", "location", "notifications"]) {
      await page.goto(`/settings?section=${unknown}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: "Booking Engine Settings" })).toBeVisible();
    }
    await page.goto("/settings/account", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toHaveCount(0);

    for (const [width, height, name] of [
      [820, 1180, "tablet"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/settings", { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: "Booking Engine Settings" })).toBeVisible();
      await testInfo.attach(`settings-grid-${name}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.goto("/settings/general", { waitUntil: "networkidle" });
    await testInfo.attach("settings-general-mobile", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await assertHealthy();
  });

  test("switches Fixed through Stripe and schedules Commission at period end", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          paymentSettings: {
            paymentsEnabled: false,
            paymentProvider: "stripe",
            acceptedMethods: [],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: null,
              provider: null,
              status: "not_configured",
              onboardingStatus: "not_started",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      }),
    );

    let plan: "commission" | "fixed" = "commission";
    let cancelAtPeriodEnd = false;
    const planResponse = () => ({
      contractVersion: "finance-subscriptions.v1",
      propertyId: BOOKING_ADMIN_PROPERTY_ID,
      planStatus: {
        plan,
        status: cancelAtPeriodEnd
          ? "cancel_at_period_end"
          : plan === "fixed"
            ? "active"
            : "commission",
        // A USD-priced hotel: the card shows the plan's own currency, never a hard-coded one (VAY-2201).
        currency: "USD",
        activeRoomCount: 6,
        amountMinor: 5_500,
        currentPeriodStart: plan === "fixed" ? "2026-08-11T12:00:00.000Z" : null,
        currentPeriodEnd: plan === "fixed" ? "2026-09-10T12:00:00.000Z" : null,
        nextBillingDate: plan === "fixed" && !cancelAtPeriodEnd ? "2026-09-10T12:00:00.000Z" : null,
        cancelAtPeriodEnd,
        checkoutPending: false,
        customerPortalAvailable: plan === "fixed",
        activatedAt: plan === "fixed" ? "2026-08-11T12:00:00.000Z" : null,
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
    });
    await page.route(`**${BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH}*`, (route) =>
      route.fulfill({ json: planResponse() }),
    );
    let checkoutCount = 0;
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/fixed-plan/checkout`,
      async (route) => {
        checkoutCount += 1;
        const body = route.request().postDataJSON() as {
          commandId: string;
          idempotencyKey: string;
        };
        expect(body.idempotencyKey).toBe(body.commandId);
        expect(body).not.toHaveProperty("customerEmail");
        plan = "fixed";
        await route.fulfill({
          json: {
            contractVersion: "finance-subscriptions.v1",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            checkout: {
              checkoutSessionId: "cs_fixed",
              checkoutUrl: new URL("/settings?billing=success", page.url()).toString(),
              currency: "USD",
              amountMinor: 5_500,
              activeRoomCount: 6,
            },
          },
        });
      },
    );
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/switch-to-commission`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          commandId: string;
          idempotencyKey: string;
        };
        expect(body.idempotencyKey).toBe(body.commandId);
        cancelAtPeriodEnd = true;
        await route.fulfill({ json: planResponse() });
      },
    );

    await page.goto("/settings/billing");
    // Billing is only the Vayada plan; guest payment methods live on Payments.
    await expect(page.getByRole("heading", { name: "Payment Methods" })).toHaveCount(0);
    await expect(page.getByText("Fixed fee based on active units")).toBeVisible();
    await expect(page.getByText("$55.00", { exact: true })).toBeVisible();
    await expect(page.getByText("every month", { exact: true })).toBeVisible();
    const unitPricing = page.getByTestId("fixed-plan-unit-pricing");
    await expect(unitPricing).toHaveText(
      "$30 for the first active unit + $5 per additional unit · 6 active units",
    );
    await expect(page.getByRole("main").getByText(/€|rooms|30 days/)).toHaveCount(0);
    for (const [width, height, name] of [
      [1440, 900, "desktop"],
      [820, 1180, "tablet"],
      [390, 844, "mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      // The description takes two lines at most: the formula, then the unit count (VAY-2201).
      const [paragraph, line] = await Promise.all([
        unitPricing.boundingBox(),
        unitPricing.locator("span").last().boundingBox(),
      ]);
      expect(Math.round(paragraph!.height / line!.height), name).toBeLessThanOrEqual(2);
      await testInfo.attach(`settings-billing-${name}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Switch to Fixed Plan" }).click();
    const fixedDialog = page.getByRole("dialog");
    await expect(fixedDialog).toContainText("You're switching to the Fixed Plan at $55.00/month.");
    await expect(fixedDialog).toContainText(
      "Your first payment will be charged today. Future payments will be charged every month.",
    );
    await fixedDialog.getByRole("button", { name: "Continue to payment" }).click();
    await expect(page.getByText("Fixed Plan is active.")).toBeVisible();
    expect(checkoutCount).toBe(1);

    await page.getByRole("button", { name: "Switch to Commission Plan" }).click();
    const commissionDialog = page.getByRole("dialog");
    await expect(commissionDialog).toContainText(
      "Commission will apply to all bookings created after that date.",
    );
    await commissionDialog.getByRole("button", { name: "Switch to Commission Plan" }).click();
    await expect(page.getByText(/Your Fixed Plan is paid through/)).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("opens Stripe Express Dashboard only for a connected property account", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    let stripeConnected = true;
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "stripe",
            acceptedMethods: ["card"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: stripeConnected
                ? "acct_property_e2e"
                : `settings-choice:${BOOKING_ADMIN_PROPERTY_ID}:stripe`,
              provider: "stripe",
              status: stripeConnected ? "active" : "not_configured",
              onboardingStatus: stripeConnected ? "completed" : "not_started",
              chargesEnabled: stripeConnected,
              payoutsEnabled: stripeConnected,
              capabilities: stripeConnected ? ["card_payments", "transfers"] : [],
            },
          },
        },
      }),
    );

    let dashboardRequest: { method: string; body: string | null } | null = null;
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/stripe/dashboard-link`,
      async (route) => {
        dashboardRequest = {
          method: route.request().method(),
          body: route.request().postData(),
        };
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
          json: { url: new URL("/stripe-dashboard-opened", page.url()).toString() },
        });
      },
    );

    await page.goto("/settings/payments");
    const dashboardButton = page.getByRole("button", { name: "View Stripe Dashboard" });
    await expect(dashboardButton).toBeVisible();
    await expect(
      page.getByText(
        "Check your payouts, balance, and payment history, or update your bank account.",
      ),
    ).toBeVisible();

    const popupPromise = page.waitForEvent("popup");
    await dashboardButton.click();
    await expect(page.getByRole("button", { name: "Opening Stripe..." })).toBeDisabled();
    const stripeDashboard = await popupPromise;
    await stripeDashboard.waitForURL("**/stripe-dashboard-opened");
    expect(dashboardRequest).toEqual({ method: "POST", body: null });

    stripeConnected = false;
    await page.reload();
    await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View Stripe Dashboard" })).toHaveCount(0);

    await assertHealthy();
  });

  test("persists Stripe before account creation and stops after a failed save", async ({
    page,
  }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    let persistedProvider: "vayada" | "stripe" = "vayada";
    let failSave = false;
    let accountCreates = 0;
    const order: string[] = [];
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            paymentSettings: {
              paymentsEnabled: true,
              paymentProvider: persistedProvider,
              acceptedMethods: ["card"],
              defaultCurrency: "EUR",
              supportedCurrencies: ["EUR"],
              requiresManualReview: false,
              providerAccount: {
                providerAccountId: null,
                provider: null,
                status: "not_configured",
                onboardingStatus: "not_started",
                chargesEnabled: false,
                payoutsEnabled: false,
                capabilities: [],
              },
            },
          },
        });
        return;
      }

      order.push("save");
      const body = route.request().postDataJSON() as {
        paymentSettings: { paymentProvider: string };
      };
      expect(body.paymentSettings.paymentProvider).toBe("stripe");
      if (failSave) {
        await route.fulfill({ status: 503, json: { error: "write unavailable" } });
        return;
      }
      persistedProvider = "stripe";
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: body.paymentSettings,
        },
      });
    });
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/stripe`,
      async (route) => {
        order.push("create");
        accountCreates += 1;
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            providerAccountId: "provider_account_e2e",
            provider: "stripe",
            providerAccountRef: "acct_e2e",
            status: "setup_incomplete",
            onboardingStatus: "invited",
            onboardingUrl: "about:blank#stripe-onboarding",
          },
        });
      },
    );

    await page.goto("/settings/payments");
    await page.getByRole("button", { name: /Stripe Connect/ }).click();
    const firstPopup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect Payment Account" }).click();
    const onboarding = await firstPopup;
    await onboarding.waitForURL("about:blank#stripe-onboarding");
    expect(order).toEqual(["save", "create"]);
    await onboarding.close();

    await page.reload();
    await expect(page.getByRole("button", { name: /Stripe Connect/ })).toHaveClass(
      /border-primary-500/,
    );
    await expect(page.getByRole("button", { name: "Connect Payment Account" })).toBeVisible();

    persistedProvider = "vayada";
    failSave = true;
    order.length = 0;
    await page.reload();
    await page.getByRole("button", { name: /Stripe Connect/ }).click();
    const failedPopup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect Payment Account" }).click();
    const closedPopup = await failedPopup;
    await closedPopup.waitForEvent("close");

    expect(order).toEqual(["save"]);
    expect(accountCreates).toBe(1);
    await expect(
      page.getByText("Could not save payment settings. Please try again."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/payments$/);
  });

  test("relinks a persisted Stripe account once without rewriting payment settings", async ({
    page,
  }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    let settingsWrites = 0;
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      if (route.request().method() !== "GET") {
        settingsWrites += 1;
        await route.fulfill({ status: 500, json: { error: "unexpected settings write" } });
        return;
      }
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "stripe",
            acceptedMethods: ["card", "bank_transfer"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            depositPolicy: {},
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: "provider_account_e2e",
              provider: "stripe",
              status: "setup_incomplete",
              onboardingStatus: "invited",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      });
    });

    let onboardingLinks = 0;
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/provider_account_e2e/onboarding-link`,
      async (route) => {
        onboardingLinks += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            providerAccountId: "provider_account_e2e",
            provider: "stripe",
            providerAccountRef: "acct_e2e",
            status: "setup_incomplete",
            onboardingStatus: "invited",
            onboardingUrl: "about:blank#stripe-relink",
          },
        });
      },
    );

    await page.goto("/settings/payments");
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Complete Onboarding" }).dblclick();
    const onboarding = await popup;
    await onboarding.waitForURL("about:blank#stripe-relink");

    expect(settingsWrites).toBe(0);
    expect(onboardingLinks).toBe(1);
    await onboarding.close();
  });

  test("reconciles Stripe on return and reloads the connected payment state", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    const onboardingFlowId = "stripe-onboarding-e2e-flow";
    await page.addInitScript(
      ({ key, value }) => {
        if (window.location.search.includes("stripe=return")) {
          window.localStorage.setItem(key, value);
        }
      },
      {
        key: stripeOnboardingPropertyKey(BOOKING_ADMIN_PROPERTY_ID),
        value: onboardingFlowId,
      },
    );

    let stripeConnected = false;
    let returnMissingAccount = false;
    let paymentSettingsReads = 0;
    let releaseInitialRead!: () => void;
    let confirmInitialReadFinished!: () => void;
    const initialReadGate = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    const initialReadFinished = new Promise<void>((resolve) => {
      confirmInitialReadFinished = resolve;
    });
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      paymentSettingsReads += 1;
      const isInitialRead = paymentSettingsReads === 1;
      if (isInitialRead) await initialReadGate;
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "stripe",
            acceptedMethods: ["card"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            depositPolicy: {},
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: returnMissingAccount ? null : "provider_account_e2e",
              provider: returnMissingAccount ? null : "stripe",
              status: returnMissingAccount
                ? "not_configured"
                : stripeConnected
                  ? "active"
                  : "setup_incomplete",
              onboardingStatus: returnMissingAccount
                ? "not_started"
                : stripeConnected
                  ? "completed"
                  : "invited",
              chargesEnabled: !returnMissingAccount && stripeConnected,
              payoutsEnabled: !returnMissingAccount && stripeConnected,
              capabilities:
                !returnMissingAccount && stripeConnected ? ["card_payments", "transfers"] : [],
            },
          },
        },
      });
      if (isInitialRead) confirmInitialReadFinished();
    });

    const reconciliationBodies: Array<Record<string, unknown>> = [];
    let failReconciliation = false;
    const forbiddenSetupRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        (pathname.endsWith("/provider-accounts/stripe") || pathname.endsWith("/onboarding-link"))
      ) {
        forbiddenSetupRequests.push(pathname);
      }
    });
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/stripe/reconcile`,
      async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        reconciliationBodies.push(body);
        expect(body.idempotencyKey).toBe(body.commandId);
        expect(body).not.toHaveProperty("providerAccountRef");
        if (failReconciliation) {
          await route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
          return;
        }
        stripeConnected = true;
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            providerAccount: {
              provider: "stripe",
              status: "setup_incomplete",
              onboardingStatus: "invited",
              chargesEnabled: false,
              payoutsEnabled: false,
              detailsSubmitted: false,
              cardPaymentsStatus: "pending",
              ready: false,
            },
          },
        });
      },
    );

    // The exact return URL Stripe Connect sends hosts back to (apps/api stripeConnect.ts).
    await page.goto("/settings?section=payments&stripe=return");

    await expect(page).toHaveURL(/\/settings\/payments$/);
    await expect(page.getByText("Stripe is connected.")).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    expect(reconciliationBodies).toEqual(
      [1, 2, 3].map((attempt) => ({
        commandId: `${onboardingFlowId}:attempt:${attempt}`,
        idempotencyKey: `${onboardingFlowId}:attempt:${attempt}`,
      })),
    );
    expect(paymentSettingsReads).toBeGreaterThanOrEqual(2);

    releaseInitialRead();
    await initialReadFinished;
    await page.waitForTimeout(100);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText("Pending Onboarding", { exact: true })).toHaveCount(0);
    const markerKey = stripeOnboardingPropertyKey(BOOKING_ADMIN_PROPERTY_ID);
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), markerKey))
      .toBe(`settled:${onboardingFlowId}`);

    await page.goto("/settings/payments");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    const readsBeforeOriginalFocus = paymentSettingsReads;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), markerKey))
      .toBeNull();
    expect(reconciliationBodies).toHaveLength(3);
    expect(paymentSettingsReads).toBeGreaterThan(readsBeforeOriginalFocus);
    await assertHealthy();

    stripeConnected = false;
    returnMissingAccount = true;
    failReconciliation = true;
    await page.goto("/settings?stripe=return");
    await expect(page).toHaveURL(/\/settings\/payments$/);
    await expect(page.getByText("Couldn't refresh Stripe status.")).toBeVisible();
    await expect(page.getByText("Pending Onboarding", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check Stripe status" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect payment account" })).toHaveCount(0);
    await page.getByRole("button", { name: "Check Stripe status" }).click();
    await expect(page.getByText("Couldn't refresh Stripe status.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect payment account" })).toHaveCount(0);
    expect(forbiddenSetupRequests).toEqual([]);
    await assertNoLegacyCalls();
  });
});

test("saves direct-only transfers while retaining an existing hosted provider", async ({
  page,
}, testInfo) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(
    `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/bank-transfer-destination`,
    async (route) => {
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: {
          destination: {
            id: BOOKING_ADMIN_PROPERTY_ID,
            revision: 1,
            version: 1,
            enabled: true,
            deleted: false,
            maskedAccount: "•••• 3000",
          },
        },
      });
    },
  );
  let write: Record<string, unknown> | null = null;
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
    if (route.request().method() === "PATCH") write = route.request().postDataJSON();
    await route.fulfill({
      json: {
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        paymentSettings: {
          paymentsEnabled: true,
          paymentProvider: "xendit",
          acceptedMethods: ["bank_transfer"],
          defaultCurrency: "EUR",
          supportedCurrencies: ["EUR"],
          depositPolicy: {},
          requiresManualReview: false,
          providerAccount: {
            providerAccountId: "provider_saved",
            provider: "xendit",
            status: "active",
            onboardingStatus: "completed",
            chargesEnabled: true,
            payoutsEnabled: true,
          },
        },
      },
    });
  });
  await page.goto("/settings/payments");
  const transfer = page
    .getByRole("heading", { name: "Direct guest bank transfers" })
    .locator("..")
    .locator("..");
  await expect(page.getByText(/Saved account: •••• 3000/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment Methods" })).toBeVisible();
  await testInfo.attach("settings-payments", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/payment-settings"),
  );
  // One Save covers payment methods, bank details and the provider.
  const savePayments = page.getByRole("button", { name: "Save Changes", exact: true });
  await savePayments.click();
  await response;
  expect(write).toMatchObject({ paymentSettings: { acceptedMethods: ["bank_transfer"] } });
  expect(write?.paymentSettings).not.toHaveProperty("paymentProvider");
  await transfer.getByPlaceholder("e.g. HSBC Bank").fill("Partial replacement");
  await savePayments.click();
  await expect(
    page.getByText(
      "Enter the complete bank details, or leave all fields empty to keep the saved account.",
      { exact: true },
    ),
  ).toBeVisible();
});

// VAY-2185: setup saves plain Pay at Hotel (no Cash/Card choice); Booking Admin showed nothing
// picked and every Save failed in the browser with "Failed to save".
function financePaymentSettings(acceptedMethods: string[], paymentsEnabled = true) {
  return {
    contractVersion: "finance-route-contracts.v1",
    propertyId: BOOKING_ADMIN_PROPERTY_ID,
    paymentSettings: {
      paymentsEnabled,
      paymentProvider: "manual",
      acceptedMethods,
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      depositPolicy: {},
      requiresManualReview: false,
      providerAccount: {
        providerAccountId: null,
        provider: null,
        status: "not_configured",
        onboardingStatus: "not_started",
        chargesEnabled: false,
        payoutsEnabled: false,
        capabilities: [],
      },
    },
  };
}

async function mockPaymentWrites(
  page: Page,
  acceptedMethods: string[],
  responses: Array<{ status: number; json: Record<string, unknown> }> = [],
  paymentsEnabled = true,
) {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const writes: Array<{ acceptedMethods: string[] }> = [];
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        paymentSettings: { acceptedMethods: string[] };
      };
      writes.push({ acceptedMethods: body.paymentSettings.acceptedMethods });
      const response = responses.shift();
      if (response) return route.fulfill(response);
      return route.fulfill({ json: financePaymentSettings(body.paymentSettings.acceptedMethods) });
    }
    return route.fulfill({ json: financePaymentSettings(acceptedMethods, paymentsEnabled) });
  });
  return writes;
}

const savePaymentsButton = (page: Page) =>
  page.getByRole("button", { name: "Save Changes", exact: true });

test("keeps setup's plain Pay at Hotel when it is saved untouched", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockPaymentWrites(page, ["pay_at_property"]);
  await page.goto("/settings/payments");
  await expect(page.getByRole("button", { name: "Cash", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Card", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("Cash & Card accepted", { exact: true })).toBeVisible();
  await testInfo.attach("settings-payments-plain-pay-at-hotel", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await savePaymentsButton(page).click();
  await expect(page.getByText("Payment settings saved").first()).toBeVisible();
  expect(writes).toEqual([{ acceptedMethods: ["pay_at_property"] }]);

  // Off and on again still shows Cash and Card, so nothing changed.
  await page.getByText("Pay at Hotel", { exact: true }).click();
  await page.getByText("Pay at Hotel", { exact: true }).click();
  await savePaymentsButton(page).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ acceptedMethods: ["pay_at_property"] });

  // A changed choice is sent as shown.
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await savePaymentsButton(page).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toEqual({ acceptedMethods: ["pay_at_property", "cash"] });
  await assertHealthy();
});

// VAY-2235: "Cash & Card accepted" sat beside the Cash/Card buttons and spilled out of the card into
// Bank Transfer. It now sits on its own line below the buttons, inside the card, at every width.
test("keeps the Pay at Hotel choice inside its card at every width", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPaymentWrites(page, ["pay_at_property", "cash", "manual_card"]);
  await page.goto("/settings/payments");
  const methods = page.locator('fieldset[aria-labelledby="payment-methods-heading"]');
  await expect(methods).toHaveAttribute("aria-disabled", "false");
  // The card that holds the Cash/Card choice (PayPal is a <div> card too).
  const card = methods
    .locator(":scope > div")
    .filter({ has: page.getByRole("button", { name: "Cash", exact: true }) });
  const cash = card.getByRole("button", { name: "Cash", exact: true });
  const cardChoice = card.getByRole("button", { name: "Card", exact: true });
  const states = [
    ["Cash & Card accepted", async () => {}],
    ["Cash only", () => cardChoice.click()],
    [
      "Card only",
      async () => {
        await cardChoice.click();
        await cash.click();
      },
    ],
  ] as const;
  for (const [status, choose] of states) {
    await choose();
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [1024, 768],
      [640, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      const text = card.getByText(status, { exact: true });
      await expect(text).toBeVisible();
      const where = `${status} at ${width}px`;
      // Nothing in the card is wider than the card.
      expect(
        await card.evaluate((element) => element.scrollWidth <= element.clientWidth),
        where,
      ).toBe(true);
      const cardBox = (await card.boundingBox())!;
      const buttonBox = (await cash.boundingBox())!;
      // The rendered text itself, not its block, which is always as wide as the card.
      const textBox = await text.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = range.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top };
      });
      expect(textBox.left, where).toBeGreaterThanOrEqual(cardBox.x);
      expect(textBox.right, where).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      expect(textBox.top, `${where}: below the buttons`).toBeGreaterThanOrEqual(
        buttonBox.y + buttonBox.height,
      );
      expect(Math.round(textBox.left), `${where}: left-aligned with Cash`).toBe(
        Math.round(buttonBox.x),
      );
      if (status === "Cash & Card accepted" && (width === 1440 || width === 390)) {
        await methods.screenshot({
          path: testInfo.outputPath(`vay2235-pay-at-hotel-${width}.png`),
        });
      }
    }
  }
  await assertHealthy();
});

test("re-sends Cash and Card once when Finance needs the Pay at Hotel choice", async ({ page }) => {
  const writes = await mockPaymentWrites(
    page,
    ["pay_at_property"],
    [
      {
        status: 400,
        json: {
          statusCode: 400,
          code: "invalid_command",
          category: "validation",
          message: "Pay at Hotel requires cash, card, or both.",
        },
      },
    ],
  );
  await page.goto("/settings/payments");
  await expect(page.getByText("Cash & Card accepted", { exact: true })).toBeVisible();
  await savePaymentsButton(page).click();
  await expect(page.getByText("Payment settings saved").first()).toBeVisible();
  expect(writes).toEqual([
    { acceptedMethods: ["pay_at_property"] },
    { acceptedMethods: ["pay_at_property", "cash", "manual_card"] },
  ]);
});

test("starts a newly switched-on Pay at Hotel with Cash and Card", async ({ page }) => {
  const writes = await mockPaymentWrites(page, [], [], false);
  await page.goto("/settings/payments");
  await expect(page.getByRole("heading", { name: "Payment Methods" })).toBeVisible();
  await page.getByText("Pay at Hotel", { exact: true }).click();
  await expect(page.getByText("Cash & Card accepted", { exact: true })).toBeVisible();
  await savePaymentsButton(page).click();
  await expect(page.getByText("Payment settings saved").first()).toBeVisible();
  expect(writes).toEqual([{ acceptedMethods: ["pay_at_property", "cash", "manual_card"] }]);
});

// A click made before the saved methods arrived was undone when they did, which also made
// the test above flaky on a slow load.
test("waits for the saved payment methods before a click counts", async ({ page }) => {
  const writes = await mockPaymentWrites(page, [], [], false);
  let releaseRead = () => {};
  let readHeld = () => {};
  const readReleased = new Promise<void>((resolve) => (releaseRead = resolve));
  const readIsHeld = new Promise<void>((resolve) => (readHeld = resolve));
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
    if (route.request().method() === "GET") {
      readHeld();
      await readReleased;
    }
    await route.fallback();
  });
  await page.goto("/settings/payments");
  // The cards are on screen and the saved methods are still on their way.
  await expect(page.getByText("Pay at Hotel", { exact: true })).toBeVisible();
  await readIsHeld;
  const click = page.getByText("Pay at Hotel", { exact: true }).click();
  await page.waitForTimeout(300);
  releaseRead();
  await click;
  await expect(page.getByText("Cash & Card accepted", { exact: true })).toBeVisible();
  await savePaymentsButton(page).click();
  await expect(page.getByText("Payment settings saved").first()).toBeVisible();
  expect(writes).toEqual([{ acceptedMethods: ["pay_at_property", "cash", "manual_card"] }]);
});

test("says what went wrong when payments don't save, and offers Try again", async ({
  page,
}, testInfo) => {
  const writes = await mockPaymentWrites(
    page,
    ["pay_at_property", "cash"],
    [
      {
        status: 409,
        json: {
          statusCode: 409,
          code: "property_currency_conflict",
          category: "conflict",
          message: "Payment currency changed to LKR. Reload before saving.",
        },
      },
      {
        status: 503,
        json: {
          statusCode: 503,
          code: "write_model_unavailable",
          category: "write_model",
          message: "Finance is unavailable.",
        },
      },
    ],
  );
  await page.goto("/settings/payments");
  await expect(page.getByText("Cash only", { exact: true })).toBeVisible();
  await savePaymentsButton(page).click();
  const banner = page.getByRole("alert").filter({ hasText: "Your hotel's currency changed." });
  await expect(banner).toHaveText(
    "Your hotel's currency changed. Reload the page, then save again.",
  );
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);

  await savePaymentsButton(page).click();
  await expect(
    page.getByText("Could not save payment settings. Please try again.").first(),
  ).toBeVisible();
  await testInfo.attach("settings-payments-save-error", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Payment settings saved").first()).toBeVisible();
  expect(writes).toHaveLength(3);
  await expect(page.getByText("Failed to save", { exact: true })).toHaveCount(0);
});
