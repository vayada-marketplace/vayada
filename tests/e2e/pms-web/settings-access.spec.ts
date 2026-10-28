import { expect, test, type Page } from "@playwright/test";
import { mockPmsWebAuthenticatedSession, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2154: Settings show each section read-only, or say the role can't open it, when the role
// can't save it; the API refuses those saves either way.
const VIEW_ONLY = "You can see these settings, but your role can't change them.";
const NO_ACCESS = "Your role can't see or change these settings.";

// Without permissions: the shared mocks' owner, who holds every key.
async function signInWith(page: Page, permissions?: string[]) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  if (!permissions) return;
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({ json: { membershipId: "member-1", roleKey: "hotel_custom", permissions } }),
  );
}

test("a role that may only read settings has nothing to change", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/(pms|finance|booking|hotel-setup)\//.test(request.url())
    )
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await signInWith(page, ["pms.dashboard.read", "pms.settings.read", "booking.settings.read"]);
  const main = page.locator("main");
  const shot = async (name: string) =>
    testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });

  await page.goto("/settings/calendar");
  await expect(main.getByRole("note")).toHaveText([NO_ACCESS, VIEW_ONLY]);
  await expect(main.getByRole("switch", { name: "Allow same-day bookings" })).toBeDisabled();
  await expect(main.getByRole("switch", { name: "Optimize room assignments" })).toHaveCount(0);
  await shot("settings-calendar-reader");

  await page.goto("/settings/property");
  await expect(main.getByRole("note")).toHaveText([NO_ACCESS, NO_ACCESS]);
  await expect(main.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await shot("settings-property-reader");

  await page.goto("/settings/guest-flows");
  await expect(main.getByRole("note")).toHaveText(NO_ACCESS);
  await page.goto("/settings/ota-commissions");
  await expect(main.getByRole("note")).toHaveText(NO_ACCESS);
  await page.goto("/settings/billing");
  await expect(main.getByRole("note")).toHaveText("Only the owner can see billing.");
  await shot("settings-billing-reader");

  expect(writes).toEqual([]);
  await assertHealthy();
});

test("a role that reads finance sees the OTA rates without Change buttons", async ({ page }) => {
  await signInWith(page, ["pms.dashboard.read", "pms.settings.read", "pms.finance.read"]);
  await page.goto("/settings/ota-commissions");
  const main = page.locator("main");
  await expect(main.getByRole("note")).toHaveText(VIEW_ONLY);
  await expect(main.getByRole("list", { name: /channels/i }).getByRole("listitem")).not.toHaveCount(
    0,
  );
  await expect(main.getByRole("button", { name: "Change" })).toHaveCount(0);
});

test("the owner still gets every settings control", async ({ page }) => {
  await signInWith(page);
  await page.goto("/settings/calendar");
  const main = page.locator("main");
  await expect(main.getByRole("switch", { name: "Optimize room assignments" })).toBeEnabled();
  await expect(main.getByRole("switch", { name: "Allow same-day bookings" })).toBeEnabled();
  await expect(main.getByRole("note")).toHaveCount(0);
});
