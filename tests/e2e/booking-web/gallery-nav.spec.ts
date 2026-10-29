import { expect, test, type Locator } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2414: the photo gallery opens from a white "Gallery" pill in the top nav, left of Contact.
// The hero no longer carries its own "View photos" button.
test.describe("booking-web gallery in the top nav", () => {
  for (const width of [1440, 390]) {
    test(`opens the photo gallery from the nav at ${width}px`, async ({ page }, testInfo) => {
      const assertHealthy = watchPageHealth(page, testInfo);
      await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
      await mockBookingApis(page);
      await page.goto("/");

      const nav = page.locator("nav");
      const gallery = nav.getByRole("button", { name: "Open photo gallery" });
      await expect(gallery).toBeVisible();
      await expect(page.getByRole("button", { name: "Open photo gallery" })).toHaveCount(1);
      await expect(page.getByRole("button", { name: /View photos/ })).toHaveCount(0);

      const contact =
        width > 600
          ? nav.getByRole("button", { name: "Contact", exact: true })
          : nav.getByTestId("mobile-contact-button");
      const galleryBox = (await gallery.boundingBox())!;
      const contactBox = (await contact.boundingBox())!;
      expect(contactBox.x - (galleryBox.x + galleryBox.width)).toBeCloseTo(8, 0);
      expect(galleryBox.y + galleryBox.height / 2).toBeCloseTo(
        contactBox.y + contactBox.height / 2,
        0,
      );
      await expect(gallery).toHaveCSS("background-color", "rgb(255, 255, 255)");
      if (width > 600) {
        await expect(gallery).toHaveText("Gallery");
        expect(galleryBox.height).toBe(40);
      } else {
        // Icon only, like Contact; the 28px circle answers taps up to 22px from its centre.
        await expect(gallery).toHaveText("");
        expect(await answersTapsWithin(gallery, 21)).toBe(true);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`gallery-nav-${width}.png`) });

      await gallery.click();
      const dialog = page.getByRole("dialog", { name: "Our photo gallery for Hotel Alpenrose" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("1 / 1", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(gallery).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close our photo gallery" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(gallery).toBeFocused();

      await assertHealthy();
    });
  }

  test("shows no gallery button for a hotel without photos", async ({ page }) => {
    await mockBookingApis(page, { noPhotos: true });
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open photo gallery" })).toHaveCount(0);
  });
});

/** True when taps `reach` px left, right, above and below the button's centre all land on it. */
async function answersTapsWithin(button: Locator, reach: number) {
  return button.evaluate((element, reach) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const offsets: Array<[number, number]> = [
      [-reach, 0],
      [reach, 0],
      [0, -reach],
      [0, reach],
    ];
    return offsets.every(([dx, dy]) => element.contains(document.elementFromPoint(x + dx, y + dy)));
  }, reach);
}
