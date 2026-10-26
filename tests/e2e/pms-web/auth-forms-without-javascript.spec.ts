import { test } from "@playwright/test";

import {
  expectHydratedFormPosts,
  expectServerRenderedFormsPost,
  expectSignInKeepsCredentialsOutOfTheUrl,
} from "../support/authFormsWithoutJavaScript";

test.describe("before the page is interactive", () => {
  // With JavaScript off the page behaves like one clicked before it hydrates (VAY-2271).
  test.use({ javaScriptEnabled: false });

  test("signing in keeps the email and password out of the URL", async ({ page }) => {
    await expectSignInKeepsCredentialsOutOfTheUrl(page);
  });

  for (const path of ["/login", "/signup"]) {
    test(`every form on ${path} posts`, async ({ page }) => {
      await expectServerRenderedFormsPost(page, path);
    });
  }
});

// The reset-password form only renders once the page has read its token in the browser.
test("the reset-password form posts", async ({ page }) => {
  await expectHydratedFormPosts(page, "/reset-password?token=e2e-reset-token");
});
