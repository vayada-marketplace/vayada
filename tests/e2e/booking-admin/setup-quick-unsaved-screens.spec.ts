import { expect, test, type Page } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";
import { mockBookingDashboardExit } from "../support/setupExitHandoff";
import {
  QUICK_SETUP_PROPERTY_ID,
  mockQuickSetupExistingHotel,
  primeQuickSetupBrowserState,
  quickSetupUrl,
} from "../support/quickSetupMocks";

// VAY-2383: the first run's screens must not say "Saved as you type" for answers that only live on this
// device, and "Save & exit" on the "Your hotel" edit must save the edits (or say why it can't) instead of
// dropping them. The quick setup sits behind ONBOARDING_V2_ENABLED, which PR Checks' server doesn't set.
test.skip(
  process.env.E2E_ONBOARDING_V2 !== "1",
  "needs a Booking Admin server with ONBOARDING_V2_ENABLED=true (run with E2E_ONBOARDING_V2=1)",
);

const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
/** The footer renders once for desktop and once for phones; the desktop one is visible at 1280px. */
const back = (page: Page) => page.getByRole("button", { name: "Back" }).first();
/** The form's alert (Next's route announcer is an empty alert too). */
const alert = (page: Page, text: string | RegExp) =>
  page.getByRole("alert").filter({ hasText: text });

async function openYourHotelEdit(page: Page, baseURL: string | undefined) {
  await primeQuickSetupBrowserState(page);
  const state = await mockQuickSetupExistingHotel(page);
  await page.goto(quickSetupUrl(baseURL));
  await expect(heading(page, "Your first room and price")).toBeVisible();
  // Back from the first room lands on the last of the three "Your hotel" screens.
  await back(page).click();
  await expect(heading(page, "How guests reach you")).toBeVisible();
  await back(page).click();
  await expect(heading(page, "Where it is")).toBeVisible();
  await back(page).click();
  await expect(heading(page, "Your hotel")).toBeVisible();
  return state;
}

test("the first room screen says its answers are kept on this device, not saved", async ({
  page,
  baseURL,
}, testInfo) => {
  await primeQuickSetupBrowserState(page);
  await mockQuickSetupExistingHotel(page);
  const assertHealthy = watchPageHealth(page, testInfo, {
    expectedMissingUrls: [new RegExp(`/pricing-source$`)],
  });
  await page.goto(quickSetupUrl(baseURL));
  await expect(heading(page, "Your first room and price")).toBeVisible();
  await expect(page.getByText("Step 5 of 7")).toBeVisible();
  await expect(
    page.getByText("Kept on this device until you finish “How guests pay”"),
  ).toBeVisible();
  await expect(page.getByText("Saved as you type")).toHaveCount(0);
  await assertHealthy();
});

test("Save & exit on Your hotel saves the edit with the same save as Continue, then leaves", async ({
  page,
  baseURL,
}, testInfo) => {
  const state = await openYourHotelEdit(page, baseURL);
  const assertHealthy = watchPageHealth(page, testInfo, {
    expectedMissingUrls: [new RegExp(`/pricing-source$`)],
  });
  const exitUrl = await mockBookingDashboardExit(page, baseURL, QUICK_SETUP_PROPERTY_ID);
  await expect(page.getByText("Saved as you type")).toHaveCount(0);
  await expect(
    page.getByText("Not saved yet: finish with Continue, or use Save & exit"),
  ).toBeVisible();
  await page.getByRole("textbox", { name: /Hotel name/ }).fill("Alpenrose Munich Old Town");
  await page.getByRole("button", { name: "Save & exit" }).click();
  await expect(alert(page, /./)).toHaveCount(0);
  await expect.poll(() => page.url()).toBe(exitUrl);
  expect(state.profileWrites).toHaveLength(1);
  expect(state.profileWrites[0]).toMatchObject({
    expectedProfileRevision: 4,
    patch: { displayName: "Alpenrose Munich Old Town", propertyType: "hotel" },
  });
  await assertHealthy();
});

// No page-health watch: the refused profile write (409) is the point of this test and logs to the console.
test("Save & exit stays on Your hotel and says why when the save is refused", async ({
  page,
  baseURL,
}) => {
  const state = await openYourHotelEdit(page, baseURL);
  const exitUrl = await mockBookingDashboardExit(page, baseURL, QUICK_SETUP_PROPERTY_ID);
  state.profilePutStatus = 409;
  await page.getByRole("textbox", { name: /Hotel name/ }).fill("Alpenrose Munich Old Town");
  await page.getByRole("button", { name: "Save & exit" }).click();
  await expect(alert(page, "Someone else changed this hotel meanwhile")).toBeVisible();
  await expect(heading(page, "Your hotel")).toBeVisible();
  expect(page.url()).not.toBe(exitUrl);
  expect(state.profileWrites).toHaveLength(1);
  // The edit is still there to try again.
  await expect(page.getByRole("textbox", { name: /Hotel name/ })).toHaveValue(
    "Alpenrose Munich Old Town",
  );
});

test("Save & exit without an edit leaves without a save, and an incomplete edit stays with the gap named", async ({
  page,
  baseURL,
}) => {
  const state = await openYourHotelEdit(page, baseURL);
  const exitUrl = await mockBookingDashboardExit(page, baseURL, QUICK_SETUP_PROPERTY_ID);
  await page.getByRole("textbox", { name: /Hotel name/ }).fill("");
  await page.getByRole("button", { name: "Save & exit" }).click();
  await expect(page.getByText("Enter your hotel's name.")).toBeVisible();
  await expect(alert(page, "can't be saved yet")).toBeVisible();
  expect(state.profileWrites).toHaveLength(0);
  await page.getByRole("textbox", { name: /Hotel name/ }).fill("Alpenrose Munich");
  await page.getByRole("button", { name: "Save & exit" }).click();
  await expect.poll(() => page.url()).toBe(exitUrl);
  // Nothing changed against the loaded hotel, so nothing was written.
  expect(state.profileWrites).toHaveLength(0);
});

// VAY-2394: Back from the first "Your hotel" edit screen saves an edit with the same save as Save & exit
// (or stays and says why), instead of dropping it on the way back to the first room.
test("Back from the first Your hotel screen saves the edit, then goes back to the first room", async ({
  page,
  baseURL,
}, testInfo) => {
  const state = await openYourHotelEdit(page, baseURL);
  const assertHealthy = watchPageHealth(page, testInfo, {
    expectedMissingUrls: [new RegExp(`/pricing-source$`)],
  });
  await page.getByRole("textbox", { name: /Hotel name/ }).fill("Alpenrose Munich Old Town");
  await back(page).click();
  await expect(heading(page, "Your first room and price")).toBeVisible();
  expect(state.profileWrites).toHaveLength(1);
  expect(state.profileWrites[0]).toMatchObject({
    expectedProfileRevision: 4,
    patch: { displayName: "Alpenrose Munich Old Town", propertyType: "hotel" },
  });
  // Opening "Your hotel" again shows the saved name.
  await back(page).click();
  await expect(heading(page, "How guests reach you")).toBeVisible();
  await back(page).click();
  await back(page).click();
  await expect(heading(page, "Your hotel")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Hotel name/ })).toHaveValue(
    "Alpenrose Munich Old Town",
  );
  expect(state.profileWrites).toHaveLength(1);
  await assertHealthy();
});

test("Back from the first Your hotel screen without an edit, or with one typed back, leaves without a save", async ({
  page,
  baseURL,
}, testInfo) => {
  const state = await openYourHotelEdit(page, baseURL);
  const assertHealthy = watchPageHealth(page, testInfo, {
    expectedMissingUrls: [new RegExp(`/pricing-source$`)],
  });
  await back(page).click();
  await expect(heading(page, "Your first room and price")).toBeVisible();
  expect(state.profileWrites).toHaveLength(0);
  await back(page).click();
  await expect(heading(page, "How guests reach you")).toBeVisible();
  await back(page).click();
  await back(page).click();
  await expect(heading(page, "Your hotel")).toBeVisible();
  const name = page.getByRole("textbox", { name: /Hotel name/ });
  await name.fill("Alpenrose Munich Old Town");
  await name.fill("Alpenrose Munich");
  await back(page).click();
  await expect(heading(page, "Your first room and price")).toBeVisible();
  expect(state.profileWrites).toHaveLength(0);
  await assertHealthy();
});

// No page-health watch: the refused profile write (409) is part of this test and logs to the console.
test("Back from the first Your hotel screen stays and says why when the edit can't be saved", async ({
  page,
  baseURL,
}) => {
  const state = await openYourHotelEdit(page, baseURL);
  const name = page.getByRole("textbox", { name: /Hotel name/ });
  // A gap: nothing is written and the screen names it.
  await name.fill("");
  await back(page).click();
  await expect(page.getByText("Enter your hotel's name.")).toBeVisible();
  await expect(alert(page, "Your hotel can't be saved yet")).toBeVisible();
  await expect(heading(page, "Your hotel")).toBeVisible();
  expect(state.profileWrites).toHaveLength(0);
  // A refused save: the edit stays with the reason.
  state.profilePutStatus = 409;
  await name.fill("Alpenrose Munich Old Town");
  await back(page).click();
  await expect(alert(page, "Someone else changed this hotel meanwhile")).toBeVisible();
  await expect(heading(page, "Your hotel")).toBeVisible();
  expect(state.profileWrites).toHaveLength(1);
  await expect(name).toHaveValue("Alpenrose Munich Old Town");
});
