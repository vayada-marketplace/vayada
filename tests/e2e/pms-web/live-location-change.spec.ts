import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  sharedPropertyProfile,
} from "../support/pmsWebMocks";

// VAY-2582: guests can book a live hotel, so the server saves its time zone or country only after the person
// confirms it. Without the confirmation it answers 409 location_change_needs_confirmation with the changes, and
// PMS Settings › Property asks the question Flamur approved in Paper. A Channex-connected hotel whose new time
// zone isn't Channex's gets the server's message, never the question.

type ProfileWrite = {
  expectedProfileRevision: number;
  patch: { location: { timezone?: string; countryCode?: string } };
  confirmLocationChange?: boolean;
};
type Answer = "live" | "not live" | "channex";

async function mockHotelProfile(page: Page, answer: Answer) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const location = { ...sharedPropertyProfile.profile.location };
  const state = { revision: sharedPropertyProfile.profileRevision, writes: [] as ProfileWrite[] };
  await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/profile`, (route) => {
    if (route.request().method() === "PUT") {
      const write = route.request().postDataJSON() as ProfileWrite;
      state.writes.push(write);
      const next = write.patch.location;
      const timezone =
        next.timezone && next.timezone !== location.timezone
          ? { from: location.timezone, to: next.timezone }
          : undefined;
      const countryCode =
        next.countryCode && next.countryCode !== location.countryCode
          ? { from: location.countryCode, to: next.countryCode }
          : undefined;
      // The server's answers (apps/api sharedHotelSetupStatus): Channex is checked before the confirmation.
      if (answer === "channex" && timezone)
        return route.fulfill({
          status: 409,
          json: {
            code: "channex_time_zone_mismatch",
            detail: `This hotel is connected to Channex, which uses the time zone ${location.timezone}. Your hotel's time zone must be the same. Keep ${location.timezone}, or change it in Channex first.`,
            channexTimeZone: location.timezone,
          },
        });
      if (answer === "live" && !write.confirmLocationChange && (timezone || countryCode))
        return route.fulfill({
          status: 409,
          json: {
            code: "location_change_needs_confirmation",
            detail: "This changes your live hotel's time zone. Confirm the change to save it.",
            changes: { ...(timezone ? { timezone } : {}), ...(countryCode ? { countryCode } : {}) },
          },
        });
      Object.assign(location, next);
      state.revision += 1;
    }
    return route.fulfill({
      json: {
        ...sharedPropertyProfile,
        profileRevision: state.revision,
        profile: { ...sharedPropertyProfile.profile, location },
      },
    });
  });
  await page.goto("/settings/property");
  await expect(page.getByLabel("Timezone*")).toHaveValue("Europe/Berlin");
  return state;
}

const save = (page: Page) =>
  page.locator("#property-details").getByRole("button", { name: "Save", exact: true }).click();
const timeZonePoints = [
  "recalculates your calendar in the new time zone",
  "pauses your booking page until you save your calendar again in Settings › Calendar",
  "needs your channel manager to use the same time zone, or its sync stops",
];

test.describe("pms-web live hotel location change (VAY-2582)", () => {
  test("asks before a live hotel's country and time zone move; Keep saves nothing, Change saves with the confirmation", async ({
    page,
  }) => {
    const backend = await mockHotelProfile(page, "live");
    await page.getByLabel("Timezone*").selectOption("Asia/Colombo");
    await page.getByLabel("Country (ISO code)*").fill("LK");
    await save(page);

    const question = page.getByRole("alertdialog", {
      name: "Change your hotel's country and time zone?",
    });
    await expect(question).toBeVisible();
    await expect(question).toContainText("Guests can book your hotel now.");
    await expect(question.locator("dl > div")).toHaveText([
      "CountryGermany→toSri Lanka",
      "Time zoneEurope/Berlin→toAsia/Colombo",
    ]);
    await expect(question).toContainText("Changing the time zone:");
    await expect(question.getByRole("listitem")).toHaveText(timeZonePoints);
    await expect(question).toContainText(
      "Check that your currency and channel manager still match the new country.",
    );
    const keep = question.getByRole("button", { name: "Keep current" });
    await expect(keep).toBeFocused();
    await expect(question.getByRole("button")).toHaveText([
      "Keep current",
      "Change country and time zone",
    ]);
    // The server saved nothing, and the page says nothing went wrong.
    await expect(page.locator('main div[role="alert"]')).toHaveCount(0);

    // Keep: nothing more is sent, and what the person typed stays so they can fix it.
    await keep.click();
    await expect(question).toHaveCount(0);
    await expect(page.getByLabel("Timezone*")).toHaveValue("Asia/Colombo");
    await expect(page.getByLabel("Country (ISO code)*")).toHaveValue("LK");
    await expect(page.locator("main")).not.toContainText("Property details saved");
    expect(backend.writes).toEqual([
      {
        expectedProfileRevision: 1,
        patch: { location: { countryCode: "LK", timezone: "Asia/Colombo" } },
      },
    ]);

    // Change: the same save again, confirmed.
    await save(page);
    await question.getByRole("button", { name: "Change country and time zone" }).click();
    await expect(question).toHaveCount(0);
    await expect(page.locator("main").getByText("Property details saved")).toBeVisible();
    expect(backend.writes).toHaveLength(3);
    expect(backend.writes[2]).toEqual({
      expectedProfileRevision: 1,
      patch: { location: { countryCode: "LK", timezone: "Asia/Colombo" } },
      confirmLocationChange: true,
    });
    await expect(page.getByLabel("Timezone*")).toHaveValue("Asia/Colombo");
  });

  test("asks before a time zone move alone, and Escape keeps the hotel's time zone", async ({
    page,
  }) => {
    const backend = await mockHotelProfile(page, "live");
    await page.getByLabel("Timezone*").selectOption("Europe/London");
    await save(page);

    const question = page.getByRole("alertdialog", { name: "Change your hotel's time zone?" });
    await expect(question).toBeVisible();
    await expect(question.locator("dl > div")).toHaveText([
      "Time zoneEurope/Berlin→toEurope/London",
    ]);
    await expect(question).toContainText("What this does:");
    await expect(question.getByRole("listitem")).toHaveText(timeZonePoints);
    await expect(question).not.toContainText("currency");
    await expect(question.getByRole("button")).toHaveText([
      "Keep Europe/Berlin",
      "Change time zone",
    ]);

    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    expect(backend.writes).toHaveLength(1);
    await expect(page.locator("main")).not.toContainText("Property details saved");

    await save(page);
    await question.getByRole("button", { name: "Change time zone" }).click();
    await expect(page.locator("main").getByText("Property details saved")).toBeVisible();
    expect(backend.writes.map((write) => write.confirmLocationChange)).toEqual([
      undefined,
      undefined,
      true,
    ]);
  });

  test("a Channex-connected hotel gets the server's message about Channex's time zone, no question", async ({
    page,
  }) => {
    const backend = await mockHotelProfile(page, "channex");
    await page.getByLabel("Timezone*").selectOption("Europe/London");
    await save(page);

    await expect(
      page
        .locator("main")
        .getByText(
          "This hotel is connected to Channex, which uses the time zone Europe/Berlin. Your hotel's time zone must be the same. Keep Europe/Berlin, or change it in Channex first.",
        ),
    ).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(backend.writes).toHaveLength(1);
  });

  test("a hotel guests can't book yet saves its time zone without a question", async ({ page }) => {
    const backend = await mockHotelProfile(page, "not live");
    await page.getByLabel("Timezone*").selectOption("Europe/London");
    await save(page);

    await expect(page.locator("main").getByText("Property details saved")).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(backend.writes).toEqual([
      {
        expectedProfileRevision: 1,
        patch: { location: { countryCode: "DE", timezone: "Europe/London" } },
      },
    ]);
  });
});
