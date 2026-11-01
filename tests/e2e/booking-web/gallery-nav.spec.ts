import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2414: the photo gallery opens from a white "Gallery" pill in the top nav, left of Contact.
// The hero no longer carries its own "View photos" button.
test.describe("booking-web gallery in the top nav", () => {
  for (const width of [1440, 390]) {
    test(`opens the photo gallery from the nav at ${width}px`, async ({ page }, testInfo) => {
      const assertHealthy = watchPageHealth(page, testInfo);
      await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
      await mockHotel(page);
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
        await gallery.hover();
        await expect(gallery).toHaveCSS("background-color", "rgb(240, 241, 241)");
      } else {
        // Icon only, like Contact; the 28px circle answers taps up to 22px from its centre.
        await expect(gallery).toHaveText("");
        expect(await answersTapsWithin(gallery, 21)).toBe(true);
      }
      expect(await navRightEdge(nav)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`gallery-nav-${width}.png`) });

      await gallery.click();
      const dialog = page.getByRole("dialog", { name: "Our photo gallery for Hotel Alpenrose" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("1 / 2", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(gallery).toBeFocused();
      // Back from the keyboard, the white pill shows a white outline with a gap around it.
      await expect(gallery).toHaveCSS("outline-style", "solid");
      await expect(gallery).toHaveCSS("outline-color", "rgb(255, 255, 255)");
      await expect(gallery).toHaveCSS("outline-offset", "2px");

      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close our photo gallery" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(gallery).toBeFocused();

      await assertHealthy();
    });
  }

  test("keeps every nav control on screen on a tablet with a long hotel name", async ({
    page,
  }, testInfo) => {
    const name = "Hotel Alpenrose Boutique & Wellness Resort Zermatt";
    await page.setViewportSize({ width: 768, height: 1024 });
    // Every header control on, so the nav is as full as it gets.
    await mockHotel(page, {
      hotelName: name,
      headerSettings: {
        showContactButton: true,
        showReferAGuestButton: false,
        showLanguageSelector: true,
        showCurrencySelector: true,
      },
    });
    await page.goto("/");

    const nav = page.locator("nav");
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Open photo gallery" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "EUR", exact: true })).toBeVisible();
    // The name gives way (truncates) instead of pushing the currency button off-screen.
    expect(await navRightEdge(nav)).toBeLessThanOrEqual(768);
    expect((await nav.boundingBox())?.height).toBe(64);
    await page.screenshot({ path: testInfo.outputPath("gallery-nav-768-long-name.png") });
  });

  for (const width of [1440, 390]) {
    test(`shows no gallery button for a hotel without photos at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
      await mockBookingApis(page, { noPhotos: true });
      await page.goto("/");

      await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open photo gallery" })).toHaveCount(0);
    });

    // VAY-2447: one photo is no gallery (the shared mock hotel has exactly one).
    test(`shows no gallery button for a hotel with one photo at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
      await mockBookingApis(page);
      await page.goto("/");

      await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
      await expect(contactButton(page, width)).toBeVisible();
      await expect(page.getByRole("button", { name: "Open photo gallery" })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`gallery-nav-one-photo-${width}.png`) });
    });

    test(`hides the gallery button Design Studio switched off at ${width}px (VAY-2447)`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
      await mockHotel(page, { headerSettings: everyHeaderControl }, { showGalleryButton: false });
      await page.goto("/");

      await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
      await expect(contactButton(page, width)).toBeVisible();
      await expect(page.getByRole("button", { name: "Open photo gallery" })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`gallery-nav-switched-off-${width}.png`) });
    });
  }
});

const everyHeaderControl = {
  showContactButton: true,
  showReferAGuestButton: false,
  showLanguageSelector: true,
  showCurrencySelector: true,
};

const SECOND_PHOTO = "/e2e-gallery-photo-2.png";

type MockOptions = NonNullable<Parameters<typeof mockBookingApis>[1]>;
type HotelProfileJson = {
  hotel: Record<string, unknown> & { name: string; branding?: Record<string, unknown> };
};

/**
 * VAY-2447: the Gallery button needs two photos, and the shared mock hotel has one. This runs the
 * shared mock but patches the hotel profile it serves (the mock's only RegExp route) with these
 * photos and, when given, the Gallery switch, so other specs keep the shared mock as it is.
 */
async function mockHotel(
  page: Page,
  options: MockOptions = {},
  {
    images = ["/vayada-logo.png", SECOND_PHOTO],
    showGalleryButton,
  }: { images?: string[]; showGalleryButton?: boolean } = {},
) {
  const patch = (json: HotelProfileJson): HotelProfileJson => ({
    ...json,
    hotel: {
      ...json.hotel,
      images: images.map((url) => ({ url, alt: json.hotel.name })),
      ...(showGalleryButton === undefined
        ? {}
        : { branding: { ...json.hotel.branding, showGalleryButton } }),
    },
  });
  const patchedPage = new Proxy(page, {
    get(target, property) {
      if (property !== "route") return bound(target, property);
      return (
        url: Parameters<Page["route"]>[0],
        handler: Parameters<Page["route"]>[1],
        routeOptions?: Parameters<Page["route"]>[2],
      ) =>
        target.route(
          url,
          url instanceof RegExp
            ? (route: Route, request) => handler(withPatchedJson(route, patch), request)
            : handler,
          routeOptions,
        );
    },
  });
  await mockBookingApis(patchedPage, options);
  // The second photo is the first one's file at another address.
  await page.route(`**${SECOND_PHOTO}`, (route) =>
    route.fulfill({ path: "apps/booking-web/public/vayada-logo.png" }),
  );
}

function withPatchedJson(route: Route, patch: (json: HotelProfileJson) => HotelProfileJson) {
  return new Proxy(route, {
    get(target, property) {
      if (property !== "fulfill") return bound(target, property);
      return (response: Parameters<Route["fulfill"]>[0] = {}) =>
        target.fulfill({ ...response, json: patch(response.json as HotelProfileJson) });
    },
  });
}

function bound(target: object, property: string | symbol) {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function contactButton(page: Page, width: number) {
  const nav = page.locator("nav");
  return width > 600
    ? nav.getByRole("button", { name: "Contact", exact: true })
    : nav.getByTestId("mobile-contact-button");
}

/** The right edge of the nav's rightmost visible button (the page clips, so scrollWidth can't tell). */
async function navRightEdge(nav: Locator) {
  return nav.evaluate((element) =>
    Math.max(
      ...Array.from(element.querySelectorAll("button"))
        .filter((button) => button.offsetParent !== null)
        .map((button) => button.getBoundingClientRect().right),
    ),
  );
}

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
