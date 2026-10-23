import { test } from "@playwright/test";

import {
  expectHydratedFormPosts,
  expectServerRenderedFormsPost,
  expectSignInKeepsCredentialsOutOfTheUrl,
} from "../support/authFormsWithoutJavaScript";

// The production build renders the auth forms only after hydration (VAY-2329); the dev server
// renders them on the server.
const formsMayWaitForHydration = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("before the page is interactive", () => {
  // With JavaScript off the page behaves like one clicked before it hydrates (VAY-2271).
  test.use({ javaScriptEnabled: false });

  test("signing in keeps the email and password out of the URL", async ({ page }) => {
    await expectSignInKeepsCredentialsOutOfTheUrl(page, "/login", { formsMayWaitForHydration });
  });

  for (const path of ["/login", "/signup"]) {
    test(`every form on ${path} posts`, async ({ page }) => {
      await expectServerRenderedFormsPost(page, path, { formsMayWaitForHydration });
    });
  }
});

// The reset-password form only renders once the page has read its token in the browser.
test("the reset-password form posts", async ({ page }) => {
  await expectHydratedFormPosts(page, "/reset-password?token=e2e-reset-token");
});
