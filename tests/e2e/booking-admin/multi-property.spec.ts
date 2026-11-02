import { expect, test, type Page } from "@playwright/test";
import type { AccountBookingPageUpdate } from "@vayada/domain-booking/account-booking-page";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  ACCOUNT_BOOKING_PAGE_PATH,
  accountBookingPageSummary,
  mockSinglePropertyAccountBookingPage,
  type AccountBookingPageMockProperty,
} from "../support/accountBookingPageMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";

// VAY-2457: Settings › Multi-property booking engine (Timo's admin board in VAY-2450).
const id = (n: number) => `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const photo = (name: string) => `https://media.example/${name}.png`;
const STAYS: AccountBookingPageMockProperty[] = [
  stay(1, "The Escape Villa Ubud", "villa", "Ubud", 2),
  stay(2, "Mandala's Villa", "resort", "Peliatan", 7),
  stay(3, "Mertha Carik Guest House", "guesthouse", "Ubud", 9),
  stay(4, "The Mansion", "hotel", "Ubud", 0, ["location"]),
  stay(5, "Perum Bali Arum C9", null, null, 3, ["type", "location"]),
  stay(6, "Astavaka Villa", "villa", null, 0, ["setup"]),
];
const [escape, mandala, mertha, mansion] = STAYS.map((s) => s.propertyId);
// The agency's own header image as platform media returns it (VAY-2457).
const HERO_ID = "30000000-0000-4000-8000-00000000000c";
const HERO_URL = "https://media.example/agency-hero.png";
// A 1×1 PNG, so the stays' photos load like real ones.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function stay(
  n: number,
  name: string,
  propertyType: string | null,
  area: string | null,
  units: number,
  missing: AccountBookingPageMockProperty["missing"] = [],
): AccountBookingPageMockProperty {
  return {
    propertyId: id(n),
    name,
    propertyType,
    area,
    photoUrl: missing.includes("setup") ? null : photo(`stay-${n}`),
    units,
    ready: missing.length === 0,
    missing,
    included: false,
  };
}

type Mock = {
  summary: ReturnType<typeof accountBookingPageSummary>;
  saves: AccountBookingPageUpdate[];
};

async function setup(
  page: Page,
  {
    summary = accountBookingPageSummary("The Travel Ubud", STAYS),
    getStatus = 200,
    putError,
    afterConflict,
  }: {
    summary?: ReturnType<typeof accountBookingPageSummary>;
    getStatus?: number;
    putError?: { status: number; code: string };
    afterConflict?: ReturnType<typeof accountBookingPageSummary>;
  } = {},
): Promise<Mock> {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route("https://media.example/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PNG }),
  );
  const mock: Mock = { summary, saves: [] };
  let refused = false;
  // The API is another origin: the browser asks first (OPTIONS) and needs CORS headers.
  await page.route(`**${ACCOUNT_BOOKING_PAGE_PATH}`, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return fulfillCorsPreflight(route);
    const headers = corsHeaders(route);
    if (method === "PUT") {
      const body = route.request().postDataJSON() as AccountBookingPageUpdate;
      mock.saves.push(body);
      if (putError && !refused) {
        refused = true;
        if (afterConflict) mock.summary = afterConflict;
        return route.fulfill({
          status: putError.status,
          headers,
          json: { code: putError.code, message: "refused" },
        });
      }
      const { revision, headerImageMediaId, ...saved } = body;
      mock.summary = accountBookingPageSummary("The Travel Ubud", STAYS, {
        ...saved,
        revision: revision + 1,
        headerImage: headerImageMediaId ? { mediaId: headerImageMediaId, url: HERO_URL } : null,
      });
      return route.fulfill({ headers, json: mock.summary });
    }
    if (getStatus !== 200)
      return route.fulfill({ status: getStatus, headers, json: { code: "forbidden" } });
    return route.fulfill({ headers, json: mock.summary });
  });
  return mock;
}

const row = (page: Page, propertyId: string) =>
  page.getByTestId(`multi-property-row-${propertyId}`);

/** Booking Admin scrolls inside <main>, so a full-page screenshot shows only the viewport: grow the
 * viewport to the page's height for the shot. */
async function fullShot(page: Page, path: string) {
  const viewport = page.viewportSize()!;
  const height = await page.locator("main").evaluate((main) => main.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: height + 80 });
  await page.screenshot({ path, animations: "disabled" });
  await page.setViewportSize(viewport);
}

test("opens from Settings, edits every section and saves the page", async ({ page }, testInfo) => {
  const mock = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Multi-property booking engine/ })
    .click();
  await expect(page).toHaveURL(/\/settings\/multi-property$/);
  await expect(
    page.getByRole("heading", { name: "Multi-property booking engine", level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("multi-property-save-note")).toHaveText("Not saved yet");
  await expect(page.getByTestId("multi-property-status")).toHaveText(
    "Off. Guests only see the single-property booking pages.",
  );

  // Ready stays start included; the others say what they miss and can't be switched on.
  await expect(page.getByText("3 of 6 properties included")).toBeVisible();
  for (const [propertyId, status, meta] of [
    [escape, "Live", "Villa · 2 units"],
    [mandala, "Live", "Resort · 7 units"],
    [mansion, "No location", "Hotel"],
    [STAYS[4]!.propertyId, "No type, no location", "Type missing · 3 units"],
    [STAYS[5]!.propertyId, "Not set up", "Villa"],
  ] as const) {
    await expect(row(page, propertyId).getByTestId("multi-property-status-pill")).toHaveText(
      status,
    );
    await expect(row(page, propertyId)).toContainText(meta);
  }
  await expect(page.getByRole("switch", { name: "Include The Mansion" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Include Astavaka Villa" })).toBeDisabled();

  // Page
  await page.getByRole("switch", { name: "Booking page live" }).click();
  await page.getByLabel("Page title").fill("The Travel Ubud Villas");
  await page
    .getByLabel("Page description")
    .fill("13 villas, guest houses and resorts in and around Ubud");
  await page.getByRole("textbox", { name: "Link address" }).fill("thetravelubud");
  await expect(page.getByTestId("multi-property-status")).toContainText("Live at ");
  await expect(page.getByTestId("multi-property-status")).toContainText("thetravelubud");
  await expect(page.getByTestId("multi-property-save-note")).toHaveText("Unsaved changes");

  // Header
  await page.getByRole("switch", { name: "Contact button" }).click();
  await page.getByLabel("Contact email").fill("stay@travelubud.example");
  await page.getByRole("textbox", { name: "WhatsApp" }).fill("+62 812 3456 7890");
  await page.getByLabel("Design").selectOption({ label: "Copy from Mandala's Villa" });

  // Properties: leave one out, take every ready one back, then move it up one place.
  await page.getByRole("switch", { name: "Include The Escape Villa Ubud" }).click();
  await expect(page.getByText("2 of 6 properties included")).toBeVisible();
  await expect(row(page, escape).getByTestId("multi-property-status-pill")).toHaveText("Hidden");
  await page.getByRole("button", { name: "Include all ready" }).click();
  const up = page.getByRole("button", { name: "Move The Escape Villa Ubud up" });
  await up.click();
  await expect(page.getByText("The Escape Villa Ubud moved to position 2 of 3")).toBeAttached();
  // Focus moves with the row, so the keyboard can keep moving it.
  await expect(up).toBeFocused();

  // Layout & map, Results & sorting, Filters, Stay page
  await page.getByRole("checkbox", { name: /^Map/ }).uncheck();
  await expect(page.getByLabel("Default layout").locator("option")).toHaveText([
    "List",
    "List + map",
  ]);
  await page.getByLabel("Default layout").selectOption("split");
  await page.getByLabel("Default sort").selectOption("recommended");
  await page.getByRole("switch", { name: "“Lowest price” badge" }).click();
  await page.getByRole("switch", { name: "Area", exact: true }).click();
  await expect(page.getByText("From each property: Villa, Resort, Guest house")).toBeVisible();
  await expect(page.getByTestId("multi-property-chips")).toHaveText(
    "Shown to guests: Property type · Area · Price per night · Private pool · Breakfast included",
  );
  await page.getByRole("switch", { name: "Other stays nearby" }).click();
  await expect(page.getByRole("switch", { name: "Other stays nearby" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await fullShot(page, testInfo.outputPath("multi-property-1440.png"));

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("multi-property-save-note")).toHaveText("All changes saved");
  expect(mock.saves).toEqual([
    {
      revision: 0,
      slug: "thetravelubud",
      live: true,
      propertyIds: [mandala, escape, mertha],
      headerImageMediaId: null,
      settings: {
        page: {
          title: "The Travel Ubud Villas",
          description: "13 villas, guest houses and resorts in and around Ubud",
        },
        header: {
          topLeft: "name",
          designPropertyId: mandala,
          gallery: true,
          contact: true,
          language: true,
          currency: true,
          contactEmail: "stay@travelubud.example",
          contactWhatsapp: "+6281234567890",
        },
        layout: { allowed: ["list", "split"], default: "split" },
        results: { defaultSort: "recommended", lowestPriceBadge: false, showFullStays: true },
        filters: {
          propertyType: true,
          area: true,
          price: true,
          privatePool: true,
          breakfast: true,
          freeCancellation: false,
          bedrooms: false,
        },
        stayPage: { nearby: false, map: true },
      },
    },
  ]);

  // After a reload the saved page comes back as saved.
  await page.reload();
  await expect(page.getByLabel("Page title")).toHaveValue("The Travel Ubud Villas");
  await expect(page.getByRole("switch", { name: "Booking page live" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("multi-property-save-note")).toHaveText("All changes saved");
  await expect(page.getByText("3 of 6 properties included")).toBeVisible();
});

test("uploads the agency's own header image, saves it and can remove it", async ({
  page,
}, testInfo) => {
  const mock = await setup(page);
  const sessions: Record<string, unknown>[] = [];
  await page.route("**/api/media/upload-sessions", async (route) => {
    sessions.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        uploadSession: { sessionId: "hero-session", status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: "hero-target",
            uploadUrl: "https://uploads.vayada.localhost/test",
            method: "PUT",
            headers: {},
          },
        ],
      },
    });
  });
  await page.route("**/api/media/upload-sessions/*/finalize", (route) =>
    route.fulfill({
      json: { mediaObjects: [{ mediaId: HERO_ID, variants: [{ publicCdnUrl: HERO_URL }] }] },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/multi-property");
  const header = page.locator("#mp-header");
  const note = page.getByTestId("multi-property-header-image-note");
  const input = page.getByTestId("multi-property-header-image-input");
  await expect(note).toHaveText(
    "Until you upload your own, the page shows the main photo of the stay its design comes from.",
  );

  // A file the server would refuse never starts an upload.
  await input.setInputFiles({ name: "hero.gif", mimeType: "image/gif", buffer: PNG });
  await expect(header.getByRole("alert")).toHaveText("JPG, PNG or WebP, up to 10 MB.");
  expect(sessions).toEqual([]);

  await input.setInputFiles({ name: "hero.png", mimeType: "image/png", buffer: PNG });
  await expect(note).toHaveText("Shown at the top of the agency page.");
  await expect(header.getByRole("img", { name: "Current header image" })).toHaveAttribute(
    "src",
    HERO_URL,
  );
  expect(sessions).toEqual([
    expect.objectContaining({
      purpose: "booking.account_page.header_image",
      visibility: "public",
      resource: expect.objectContaining({ product: "booking", resourceType: "booking_hotel" }),
    }),
  ]);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(mock.saves.at(-1)).toMatchObject({ headerImageMediaId: HERO_ID });
  await header.scrollIntoViewIfNeeded();
  await header.screenshot({ path: testInfo.outputPath("multi-property-header-1440.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await header.scrollIntoViewIfNeeded();
  await header.screenshot({ path: testInfo.outputPath("multi-property-header-390.png") });
  await page.setViewportSize({ width: 1440, height: 900 });

  // After a reload the saved image is back; Remove goes back to the stay's photo.
  await page.reload();
  await expect(note).toHaveText("Shown at the top of the agency page.");
  await page.getByRole("button", { name: "Remove image" }).click();
  await expect(note).toHaveText(
    "Until you upload your own, the page shows the main photo of the stay its design comes from.",
  );
  await expect(page.getByRole("button", { name: "Upload image" })).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(mock.saves.at(-1)).toMatchObject({ headerImageMediaId: null });
});

test("fits a phone and warns about included stays without a map location", async ({
  page,
}, testInfo) => {
  // Saved earlier with The Mansion, which has lost its map pin since.
  await setup(page, {
    summary: accountBookingPageSummary("The Travel Ubud", STAYS, {
      revision: 2,
      slug: "thetravelubud",
      propertyIds: [escape, mansion],
    }),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/multi-property");
  await expect(page.getByTestId("multi-property-map-warning")).toHaveText(
    "No map location yet: The Mansion. They are hidden from all maps until a location is set.",
  );
  await expect(row(page, mansion).getByTestId("multi-property-status-pill")).toHaveText(
    "No location",
  );
  // Included in the saved page, so it can leave and come back while it isn't ready.
  const include = page.getByRole("switch", { name: "Include The Mansion" });
  await include.click();
  await expect(include).toHaveAttribute("aria-checked", "false");
  await expect(include).toBeEnabled();
  await include.click();
  await expect(include).toHaveAttribute("aria-checked", "true");
  // Booking Admin scrolls inside <main>: nothing may make it scroll sideways.
  const overflow = await page
    .locator("main")
    .evaluate((main) => main.scrollWidth - main.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await fullShot(page, testInfo.outputPath("multi-property-390.png"));
});

test("loads the latest version when someone else saved meanwhile", async ({ page }) => {
  const saved = accountBookingPageSummary("The Travel Ubud", STAYS, {
    revision: 3,
    slug: "thetravelubud",
  });
  const elsewhere = accountBookingPageSummary("The Travel Ubud", STAYS, {
    revision: 4,
    slug: "thetravelubud",
    settings: {
      ...saved.page.settings,
      page: { title: "Changed elsewhere", description: "" },
    },
  });
  const mock = await setup(page, {
    summary: saved,
    putError: { status: 409, code: "page_changed" },
    afterConflict: elsewhere,
  });
  await page.goto("/settings/multi-property");
  await page.getByLabel("Page title").fill("My edit");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Someone else saved this page meanwhile. We loaded their version"),
  ).toBeVisible();
  await expect(page.getByLabel("Page title")).toHaveValue("Changed elsewhere");
  await expect(page.getByTestId("multi-property-save-note")).toHaveText("All changes saved");
  // The next save is made on the version just loaded.
  await page.getByLabel("Page title").fill("My edit again");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(mock.saves.map((save) => save.revision)).toEqual([3, 4]);
});

test("says what is wrong before saving, and when the link is taken", async ({ page }) => {
  const mock = await setup(page, { putError: { status: 409, code: "slug_taken" } });
  await page.goto("/settings/multi-property");
  await page.getByLabel("Page title").fill("   ");
  await page.getByRole("switch", { name: "Contact button" }).click();
  await page.getByRole("textbox", { name: "Link address" }).fill("The Travel Ubud");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Some fields need a look before you can save.")).toBeVisible();
  await expect(page.getByText("Add a page title.")).toBeVisible();
  await expect(
    page.getByText("Add an email address or a WhatsApp number for the Contact button."),
  ).toBeVisible();
  await expect(page.getByText("Use lowercase letters, numbers and single hyphens")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeDisabled();
  expect(mock.saves).toEqual([]);

  await page.getByLabel("Page title").fill("The Travel Ubud");
  await page.getByRole("switch", { name: "Contact button" }).click();
  await page.getByRole("textbox", { name: "Link address" }).fill("hotel-alpenrose");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("This link is already taken. Choose another one.")).toBeVisible();
  expect(mock.saves).toHaveLength(1);
});

test("explains missing access, and one-property accounts get no card", async ({ page }) => {
  await setup(page, { getStatus: 403 });
  await page.goto("/settings/multi-property");
  await expect(
    page.getByText(
      "Only members with access to all properties who manage booking settings can change this page.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByRole("main").getByRole("link", { name: /^Room Sorting/ })).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^Multi-property booking engine/ }),
  ).toHaveCount(0);

  // As the shared mocks answer: a one-property account, so Settings shows no card.
  await page.unroute(`**${ACCOUNT_BOOKING_PAGE_PATH}`);
  await mockSinglePropertyAccountBookingPage(page);
  await page.goto("/settings");
  await expect(page.getByRole("main").getByRole("link", { name: /^Room Sorting/ })).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^Multi-property booking engine/ }),
  ).toHaveCount(0);
});
