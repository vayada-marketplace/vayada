import { expect, test } from "@playwright/test";
import { mockFirstPartyAuth } from "../support/firstPartyAuth";
test("prepares hotel details and rooms before creating an invitation", async ({
  page,
  baseURL,
}) => {
  await mockFirstPartyAuth(page, {
    baseURL: baseURL!,
    key: "admin",
    label: "Vayada Admin",
    surface: "platform-admin",
  });
  await page.addInitScript(() => {
    localStorage.setItem("access_token", "e2e-platform-token");
    localStorage.setItem("token_expires_at", String(Date.now() + 3600000));
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem("isSuperAdmin", "true");
    localStorage.setItem(
      "user",
      JSON.stringify({
        id: "admin",
        email: "admin@example.test",
        status: "active",
        is_superadmin: true,
      }),
    );
  });
  let submitted: Record<string, any> | undefined;
  await page.route("**/api/marketplace/admin/invite-codes", async (route) => {
    const headers = {
      "access-control-allow-origin": baseURL!,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization,content-type",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      await route.fulfill({
        json: {
          ...submitted,
          contractVersion: "hotel-account-invite.v1",
          id: "invite",
          code: "VAY-test-prepared",
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: "2026-10-09T00:00:00Z",
          handoffPath: "/setup",
          redeemedAt: null,
        },
        headers,
      });
    } else await route.fulfill({ json: [], headers });
  });
  await page.goto("/dashboard/invite-codes");
  await page.getByRole("button", { name: "Create invite", exact: true }).click();
  await page.getByLabel("Hotel owner email").fill("owner@example.test");
  await page.getByLabel("Hotel group name").fill("Prepared Group");
  await page.getByLabel("Property name", { exact: true }).fill("Prepared Hotel");
  await page.getByRole("radio", { name: /^Hotel Operations For hotels using/ }).check();
  await page.getByLabel("Prepare hotel details and rooms").check();
  await expect(page.getByLabel("Hotel name", { exact: true })).toHaveValue("Prepared Hotel");
  await page.getByLabel("City", { exact: true }).fill("Berlin");
  await page.getByRole("button", { name: "Add prepared room type" }).click();
  await page.getByLabel("Room name", { exact: true }).fill("Garden Suite");
  expect(submitted).toBeUndefined();
  await page.getByRole("button", { name: "Create invite code", exact: true }).click();
  await expect.poll(() => submitted?.preparedData?.rooms?.[0]?.name).toBe("Garden Suite");
  expect(submitted?.preparedData.rooms[0].maxGuests).toBeNull();
  expect(submitted?.selectedTracks).toEqual(["hotel_operations"]);
  await expect(page.getByText("VAY-test-prepared", { exact: true })).toBeVisible();
});
