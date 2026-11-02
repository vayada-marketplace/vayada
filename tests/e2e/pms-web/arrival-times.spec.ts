import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebGuestRules,
} from "../support/pmsWebMocks";

// VAY-2455: Settings → Property → Check-in & check-out, from Timo's redesign. The section edits the guest rules the
// booking page shows, and saves them after a review. A property without any starts from the guest policy the PMS
// saved before and must choose what that policy left open. A preview shows the booking page as it changes.

const REVISIONS = ["5c0f3a52-5b5e-4c3f-9a51-1f3f8d1b2c4e", "7e2d4b63-6c6f-4d4a-8b62-2a4a9e2c3d5f"];
type Save = { body: Record<string, unknown>; key: string | undefined };

async function mockGuestRules(page: Page, initial: Record<string, unknown> | null) {
  let current = initial ? { revision: REVISIONS[0]!, choices: initial } : null;
  const saves: Save[] = [];
  await page.route(`**/api/booking/properties/${PMS_WEB_PROPERTY_ID}/guest-rules`, (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: { current } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    saves.push({ body, key: route.request().headers()["idempotency-key"] });
    current = { revision: REVISIONS[1]!, choices: body.choices as Record<string, unknown> };
    return route.fulfill({ json: { revision: REVISIONS[1], replayed: false } });
  });
  return saves;
}

/** The whole section: the app scrolls inside its own container, so a tall window shows all of it. */
async function shoot(page: Page, section: Locator, testInfo: TestInfo, name: string, width = 1440) {
  await page.setViewportSize({ width, height: 2600 });
  await section.screenshot({ path: testInfo.outputPath(name) });
}

test("a configured hotel changes its times, sees its day at a glance and saves them after review", async ({
  page,
}, testInfo) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const initial = pmsWebGuestRules().current.choices;
  const saves = await mockGuestRules(page, initial);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The old Booking Engine anchor opens the Property page's check-in & check-out (VAY-2275).
  await page.goto("/settings#booking-engine");
  await expect(page).toHaveURL(/\/settings\/property#arrival-times$/);
  const section = page.locator("#arrival-times");
  const status = section.getByRole("status");
  await expect(section.getByRole("heading", { name: "Check-in & check-out" })).toBeVisible();
  await expect(status).toHaveText("All changes saved");
  await expect(section.getByText("Confirm your guest policy")).toHaveCount(0);
  // The property's own time zone (the shared mock profile's Europe/Berlin).
  await expect(
    section.getByText(/^Central European (Standard|Summer) Time \(UTC\+[12]\)$/),
  ).toBeVisible();
  await expect(
    section.getByRole("img", {
      name: "Guests check out by 11:00 and check in from 15:00. That leaves 4 h to turn the room over.",
    }),
  ).toBeVisible();
  const review = section.getByRole("button", { name: "Review & save" });
  const discard = section.getByRole("button", { name: "Discard changes" });
  await expect(review).toBeDisabled();
  await expect(discard).toBeDisabled();
  await shoot(page, section, testInfo, "configured-1440.png");
  await page.setViewportSize({ width: 1440, height: 900 });

  const latest = section.getByRole("switch", { name: "Latest check-in" });
  await latest.click();
  await expect(latest).toHaveAttribute("aria-checked", "true");
  const latestTime = section.getByLabel("Latest check-in time");
  await expect(latestTime).toHaveValue("22:00");
  await latestTime.fill("14:00");
  await expect(section.getByRole("alert")).toHaveText("Must be later than 15:00.");
  await expect(status).toHaveText("Fix the highlighted field to save");
  await expect(review).toBeDisabled();
  // 00:00 is midnight at the end of the arrival day.
  await latestTime.fill("00:00");
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(section.getByText("between 15:00 and midnight", { exact: false })).toBeVisible();
  await latestTime.fill("23:00");
  const checkInChips = section.getByRole("group", { name: "Common check-in times" });
  await checkInChips.getByRole("button", { name: "16:00" }).click();
  await expect(checkInChips.getByRole("button", { name: "16:00" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(section.getByLabel("Guests can check in from")).toHaveValue("16:00");
  await expect(
    section.getByText("That leaves 5 h to turn the room over.", { exact: false }),
  ).toBeVisible();
  await expect(status).toHaveText("You have unsaved changes");
  await expect(discard).toBeEnabled();
  // The booking page preview follows every edit, beside the cards on a wide screen.
  const preview = section.getByRole("complementary", { name: "Booking page preview" });
  for (const shown of [
    "Alpenrose Munich",
    "Munich",
    "16:00 – 23:00",
    "By 11:00",
    "Welcome · under 12 = child",
    "Phone number *",
    "Special requests",
  ])
    await expect(preview).toContainText(shown);
  await expect(preview).not.toContainText("Estimated arrival time");
  const previewBox = (await preview.boundingBox())!;
  const reviewBox = (await review.boundingBox())!;
  expect(previewBox.x).toBeGreaterThanOrEqual(reviewBox.x + reviewBox.width);

  await review.click();
  const dialog = page.getByRole("dialog", { name: "Review guest policy" });
  for (const row of [
    "Check-in16:00 – 23:00",
    "Check-outBy 11:00",
    "Guest languageEnglish",
    "Children welcomeYes",
    "Adult age threshold12 and older",
    "Phone numberRequired",
    "Arrival timeNot asked",
    "Special requestsAllowed",
  ])
    await expect(dialog).toContainText(row);
  await dialog.screenshot({ path: testInfo.outputPath("review-dialog-1440.png") });
  expect(saves).toEqual([]);
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  await expect(status).toHaveText("Saved. Your booking page updates within a minute.");
  await expect(dialog).toHaveCount(0);
  expect(saves).toHaveLength(1);
  expect(saves[0]!.key).toMatch(/^arrival-times:/);
  expect(saves[0]!.body).toEqual({
    expectedRevision: REVISIONS[0],
    confirmed: true,
    choices: { ...initial, checkInTime: "16:00", checkInUntil: "23:00" },
  });

  await page.reload();
  await expect(status).toHaveText("All changes saved");
  await expect(section.getByRole("switch", { name: "Latest check-in" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(section.getByLabel("Latest check-in time")).toHaveValue("23:00");
  await expect(section.getByLabel("Guests can check in from")).toHaveValue("16:00");
});

test("a property without guest rules confirms its first guest policy, also on a phone", async ({
  page,
}, testInfo) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const saves = await mockGuestRules(page, null);
  // The PMS guest policy saved before VAY-2455: its catalog times, with language and children left open.
  await page.route(
    `**/api/booking/properties/${PMS_WEB_PROPERTY_ID}/booking-guest-policy`,
    (route) =>
      route.fulfill({
        json: {
          propertyId: PMS_WEB_PROPERTY_ID,
          current: null,
          draft: {
            defaultGuestLanguage: null,
            childrenEnabled: null,
            adultAgeThreshold: null,
            phoneRequired: true,
            arrivalTimeEnabled: false,
            specialRequestsEnabled: true,
            checkInTime: "14:00",
            checkOutTime: "12:00",
          },
        },
      }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/property#arrival-times");
  const section = page.locator("#arrival-times");
  const status = section.getByRole("status");
  await expect(section.getByText("Confirm your guest policy")).toBeVisible();
  await expect(section.getByText("2 of 5 required settings done")).toBeVisible();
  await expect(status).toHaveText("Choose 3 more required settings to save");
  await expect(section.getByLabel("Guests can check in from")).toHaveValue("14:00");
  await expect(section.getByLabel("Guests must check out by")).toHaveValue("12:00");
  const review = section.getByRole("button", { name: "Review & save" });
  await expect(review).toBeDisabled();
  await shoot(page, section, testInfo, "first-setup-1440.png");

  // A phone: everything stacks, nothing scrolls sideways. Reloaded at that width, as the sidebar animates away
  // after a resize.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(section.getByText("Confirm your guest policy")).toBeVisible();
  const overflow = await page.evaluate(() =>
    Array.from(document.querySelectorAll("html, body, main"))
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.tagName),
  );
  expect(overflow).toEqual([]);
  // The preview stacks below the save bar.
  const previewBox = (await section
    .getByRole("complementary", { name: "Booking page preview" })
    .boundingBox())!;
  expect(previewBox.y).toBeGreaterThan((await review.boundingBox())!.y);
  await shoot(page, section, testInfo, "first-setup-390.png", 390);
  await page.setViewportSize({ width: 1440, height: 900 });

  await section.getByLabel("Default guest language").selectOption("de");
  await section.getByRole("radio", { name: /Yes, children welcome/ }).check();
  await expect(status).toHaveText("Choose 1 more required setting to save");
  const age = section.getByLabel("Adult age threshold");
  await age.fill("30");
  await expect(section.getByRole("alert")).toHaveText("Enter a whole number between 1 and 21.");
  await expect(status).toHaveText("Fix the highlighted field to save");
  await section
    .getByRole("group", { name: "Common adult ages" })
    .getByRole("button", { name: "18" })
    .click();
  await expect(age).toHaveValue("18");
  await expect(section.getByText("Guests under 18 are booked as children.")).toBeVisible();
  await expect(section.getByText("5 of 5 required settings done")).toBeVisible();
  // Adults only: the age no longer counts.
  await section.getByRole("radio", { name: /No, adults only/ }).check();
  await expect(age).toHaveCount(0);
  await expect(section.getByText("4 of 4 required settings done")).toBeVisible();
  await section.getByRole("radio", { name: /Yes, children welcome/ }).check();
  await section.getByRole("switch", { name: "Ask for arrival time" }).click();
  await expect(status).toHaveText("You have unsaved changes");

  await review.click();
  const dialog = page.getByRole("dialog", { name: "Review guest policy" });
  await expect(dialog).toContainText("Guest languageDeutsch");
  await expect(dialog).toContainText("Adult age threshold18 and older");
  await expect(dialog).toContainText("Arrival timeAsked at booking");
  await expect(section.getByRole("complementary", { name: "Booking page preview" })).toContainText(
    "Check-in opens at 14:00",
  );
  await dialog.getByRole("button", { name: "Confirm & save" }).click();
  await expect(status).toHaveText("Saved. Your booking page updates within a minute.");
  await expect(section.getByText("Confirm your guest policy")).toHaveCount(0);
  expect(saves.map((save) => save.body)).toEqual([
    {
      expectedRevision: null,
      confirmed: true,
      choices: {
        defaultGuestLanguage: "de",
        childrenEnabled: true,
        adultAgeThreshold: 18,
        phoneRequired: true,
        arrivalTimeEnabled: true,
        specialRequestsEnabled: true,
        checkInTime: "14:00",
        checkOutTime: "12:00",
      },
    },
  ]);
});
