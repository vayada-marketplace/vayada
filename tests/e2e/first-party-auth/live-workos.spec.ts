import { expect, test } from "@playwright/test";
import { firstPartyAuthSurfaces } from "../support/firstPartyAuth";

const bookingAdmin = firstPartyAuthSurfaces.find(({ key }) => key === "bookingAdmin")!;

test("live WorkOS sandbox Google callback yields an app-local session", async ({ page }) => {
  test.skip(
    process.env.E2E_WORKOS_SANDBOX_GOOGLE !== "1",
    "Set E2E_WORKOS_SANDBOX_GOOGLE=1 and run headed against the local WorkOS stack.",
  );
  test.setTimeout(180_000);

  const callback = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.origin === bookingAdmin.baseURL && url.pathname === "/auth/oauth/google/callback";
  });
  await page.goto(`${bookingAdmin.baseURL}/login?returnTo=/dashboard`);
  await page.getByRole("button", { name: /continue with google/i }).click();
  const callbackRequest = await callback;
  expect(new URL(callbackRequest.url()).origin).toBe(bookingAdmin.baseURL);
  await page.waitForURL(
    (url) => url.origin === bookingAdmin.baseURL && url.pathname === "/dashboard",
  );
  const sessionStatus = await page.evaluate(
    async () =>
      (await fetch("/auth/session?surface=booking-admin", { credentials: "include" })).status,
  );
  expect(sessionStatus).toBe(200);
});
