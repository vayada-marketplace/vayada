import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

// VAY-2073: Help moved from the top bar into the profile menu, between Currency and Sign Out.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
]) {
  test(`opens Help from the profile menu at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    let supportRequest: unknown;
    await page.route("**/api/support", async (route) => {
      supportRequest = route.request().postDataJSON();
      await route.fulfill({ json: { status: "accepted", reference: "support-e2e" } });
    });

    await page.goto("/");
    const banner = page.getByRole("banner");
    await expect(banner.getByRole("button", { name: /Help/ })).toHaveCount(0);

    const avatar = banner.getByRole("button", { name: "BO", exact: true });
    await avatar.click();
    const [currencyBox, helpBox, signOutBox] = await Promise.all(
      [
        page.getByRole("button", { name: /^Currency/ }),
        page.getByRole("button", { name: "Help", exact: true }),
        page.getByRole("button", { name: "Sign Out", exact: true }),
      ].map((item) => item.boundingBox()),
    );
    expect(currencyBox!.y).toBeLessThan(helpBox!.y);
    expect(helpBox!.y).toBeLessThan(signOutBox!.y);
    await page.screenshot({ path: testInfo.outputPath("booking-admin-profile-menu.png") });

    await page.getByRole("button", { name: "Help", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Help and bug reports" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Message", { exact: true }).fill("Synthetic admin support test");
    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(dialog.getByRole("status")).toContainText("support-e2e");
    expect(supportRequest).toEqual({
      kind: "support",
      message: "Synthetic admin support test",
      // The admin home redirects to the dashboard before Help opens.
      page: "/dashboard",
      product: "booking",
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(avatar).toBeFocused();
  });
}
