import { expect, test } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";

// VAY-2098: the Location section stays off the guest page for every property until the
// surroundings feature returns behind a Feature Hub module.
for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`goes from the rooms call to action straight to the footer (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockBookingApis(page);
    const nearbyRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/nearby")) nearbyRequests.push(request.url());
    });

    await page.goto("/");
    const choose = page.getByRole("link", { name: "Choose rooms and get a price" });
    await expect(choose).toBeVisible();
    await expect(page.getByRole("region", { name: "Location" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Explore our surroundings" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Location", exact: true })).toHaveCount(0);
    await page.getByRole("contentinfo").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`location-hidden-${viewport.name}.png`) });
    expect(nearbyRequests).toEqual([]);
  });
}
