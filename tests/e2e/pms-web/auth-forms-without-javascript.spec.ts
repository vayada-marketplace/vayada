import { test } from "@playwright/test";

import {
  expectEveryFormPosts,
  expectSignInKeepsCredentialsOutOfTheUrl,
} from "../support/authFormsWithoutJavaScript";

// With JavaScript off the page behaves like one clicked before it hydrates (VAY-2271).
test.use({ javaScriptEnabled: false });

test("signing in before the page is interactive keeps the email and password out of the URL", async ({
  page,
}) => {
  await expectSignInKeepsCredentialsOutOfTheUrl(page);
});

for (const path of ["/login", "/signup", "/reset-password?token=e2e-reset-token"]) {
  test(`every form on ${path} posts`, async ({ page }) => {
    await expectEveryFormPosts(page, path);
  });
}
