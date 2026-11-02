import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2455: Settings saves the guest rules the booking page shows. A property without any starts from the guest
// policy the PMS saved before, and must choose the policies that policy left open.
for (const initial of [false, true])
  test(`arrival windows ${initial ? "initialize the guest rules" : "edit the guest rules"} and survive a settings reload`, async ({
    page,
  }, testInfo) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    let choices = {
      defaultGuestLanguage: "en",
      childrenEnabled: false,
      adultAgeThreshold: null,
      phoneRequired: true,
      arrivalTimeEnabled: false,
      specialRequestsEnabled: true,
      checkInTime: "15:00",
      checkOutTime: "11:00",
      checkInUntil: "22:00",
      checkOutFrom: "07:00",
    };
    const original = { ...choices };
    const revisions = [
      "5c0f3a52-5b5e-4c3f-9a51-1f3f8d1b2c4e",
      "7e2d4b63-6c6f-4d4a-8b62-2a4a9e2c3d5f",
    ];
    let revision: string | null = initial ? null : revisions[0]!;
    const saves: unknown[] = [];
    await page.route(`**/api/booking/properties/${PMS_WEB_PROPERTY_ID}/guest-rules`, (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        saves.push(body);
        expect(route.request().headers()["idempotency-key"]).toMatch(/^arrival-times:/);
        expect(body.expectedRevision).toBe(revision);
        choices = body.choices;
        revision = revisions[1]!;
        return route.fulfill({ json: { revision, replayed: false } });
      }
      return route.fulfill({ json: { current: revision ? { revision, choices } : null } });
    });
    // The PMS guest policy saved before VAY-2455: the first rules' times, with language and children left open.
    await page.route(
      `**/api/booking/properties/${PMS_WEB_PROPERTY_ID}/booking-guest-policy`,
      (route) =>
        route.fulfill({
          json: {
            propertyId: PMS_WEB_PROPERTY_ID,
            current: null,
            draft: { ...choices, defaultGuestLanguage: null, childrenEnabled: null },
          },
        }),
    );
    // The old Booking Engine anchor opens the Property page's arrival times (VAY-2275).
    await page.goto("/settings#booking-engine");
    await expect(page).toHaveURL(/\/settings\/property#arrival-times$/);
    if (initial) {
      await expect(page.getByLabel("Guests can check in from")).toHaveValue("15:00");
      await page.getByLabel("Default guest language").selectOption("en");
      await page.getByLabel("Are children welcome?").selectOption("false");
    } else {
      await expect(page.getByLabel("Default guest language")).toHaveCount(0);
    }
    await page.getByLabel("Check-in until (optional)").fill("23:00");
    await page.getByRole("button", { name: "Review policy", exact: true }).click();
    await expect(page.locator("#arrival-times")).toContainText(
      "Check-in: 15:00–23:00. Check-out: 07:00–11:00.",
    );
    const save = page.getByRole("button", { name: "Save arrival times", exact: true });
    await expect(save).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I have reviewed how these times and guest policies will appear to guests.",
      })
      .check();
    await save.click();
    await expect(page.getByText("Arrival times saved.", { exact: false })).toBeVisible();
    expect(saves).toEqual([
      {
        expectedRevision: initial ? null : revisions[0],
        confirmed: true,
        choices: { ...original, checkInUntil: "23:00" },
      },
    ]);
    await page.reload();
    await expect(page.getByLabel("Check-in until (optional)")).toHaveValue("23:00");
    await expect(page.getByLabel("Guests must check out by")).toHaveValue("11:00");
    await page
      .locator("#arrival-times")
      .screenshot({ path: testInfo.outputPath("arrival-times.png") });
  });
