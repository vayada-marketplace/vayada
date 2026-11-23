import { expect, test } from "@playwright/test";
import {
  expectCspOnPage,
  expectNotFrameable,
  watchCspViolations,
} from "../support/contentSecurityPolicy";
import { mockPmsWebAuthenticatedSession, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";

// VAY-2516: the main pages send the policy, Next's scripts carry its nonce, and nothing on them
// breaks it, so the policy can later be enforced.
const MAIN_PAGES = ["/dashboard", "/calendar", "/bookings", "/inbox", "/settings"];

test("the main pages send the policy and break none of it", async ({ page }) => {
  // One test walks every page, so allow for a dev server compiling each route once.
  test.setTimeout(180_000);
  const violations = await watchCspViolations(page);
  const check = async (route: string) => {
    const response = await page.goto(route);
    await expect(page).toHaveURL((url) => url.pathname === route);
    await page.waitForLoadState("networkidle");
    await expectCspOnPage(page, response);
    expect(await violations(), route).toEqual([]);
  };

  // Signed out first: a signed-in visit to /login moves on to the Dashboard.
  await check("/login");
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  for (const route of MAIN_PAGES) await check(route);
});

test("another site can't show PMS in a frame", async ({ page, baseURL }) => {
  await expectNotFrameable(page, `${baseURL}/login`);
});
