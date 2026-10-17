import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_ORGANIZATION_ID,
  BOOKING_ADMIN_PUBLIC_PROPERTY_PROFILE_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  defaultBookingAdminDesignSettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminDesignSettings,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { corsHeaders as sharedCorsHeaders, fulfillCorsPreflight } from "../support/cors";
import {
  createAdaptiveHotelSetupStatusMock,
  mockHotelSetupPrerequisites,
} from "../support/sharedHotelSetupMocks";

const CANONICAL_PUBLIC_DESCRIPTION =
  "A Marketplace-authored description that must remain canonical for every public surface.";

test.describe("booking-admin adaptive setup", () => {
  // Booking Admin hosts the shared hotel setup wizard itself (VAY-2261); /setup used to redirect
  // to the Marketplace app. The detailed wizard flows live in setup-*.spec.ts of this project.
  test("hosts the hotel setup wizard locally and keeps the setup context in its own URL", async ({
    page,
    baseURL,
  }) => {
    await mockSetupOwnerSession(page);
    await page.route(/\/api\/hotel-setup\/imports\/prepared(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      await route.fulfill({ status: 200, headers: sharedCorsHeaders(route), json: { import: null } });
    });
    // The page asks for the entry product in its URL (pms here); the status must answer for it.
    await mockHotelSetupPrerequisites(
      page,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "pms",
        organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: null,
      }),
    );
    const foreignNavigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || frame.url() === "about:blank") return;
      if (new URL(frame.url()).origin !== new URL(baseURL!).origin)
        foreignNavigations.push(frame.url());
    });

    await page.goto(
      `/setup?entryProduct=pms&returnTo=${encodeURIComponent("/settings?section=booking")}&mode=add`,
    );

    await expect(
      page.getByRole("heading", { name: "Let’s get to know your hotel", level: 1 }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/setup");
    expect(new URL(page.url()).searchParams.get("entryProduct")).toBe("pms");
    expect(foreignNavigations).toEqual([]);
  });

  test("treats an old Marketplace entry link as booking setup", async ({ page }) => {
    await mockSetupOwnerSession(page);
    await page.route(/\/api\/hotel-setup\/imports\/prepared(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      await route.fulfill({ status: 200, headers: sharedCorsHeaders(route), json: { import: null } });
    });
    const statusRequests: string[] = [];
    await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      statusRequests.push(new URL(route.request().url()).searchParams.get("entryProduct") ?? "");
      await route.fulfill({
        status: 200,
        headers: sharedCorsHeaders(route),
        json: createAdaptiveHotelSetupStatusMock({
          entryProduct: "booking",
          organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
          organizationDisplayName: "Alpenrose Hotel Group",
          selectedTracks: ["hotel_operations"],
          propertyId: null,
        }),
      });
    });

    await page.goto("/setup?entryProduct=marketplace&returnTo=%2Fmarketplace");

    await expect(
      page.getByRole("heading", { name: "Let’s get to know your hotel", level: 1 }),
    ).toBeVisible();
    await expect.poll(() => statusRequests.length).toBeGreaterThan(0);
    expect(statusRequests.every((entryProduct) => entryProduct === "booking")).toBe(true);
  });

  test("uploads and replaces the hero as the canonical cover, with retry after failures", async ({
    page,
  }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    const { requests: designRequests } = await mockBookingAdminDesignSettings(page, {
      ...defaultBookingAdminDesignSettings,
      heroImage: "",
    });
    const media = await mockCanonicalHeroMedia(page);

    await page.goto("/design-studio");
    const heroImage = page.locator('img[alt="Hero"]');
    const heroInput = page.getByTestId("hero-image-input");
    const tryAgain = page.getByRole("button", { name: "Try again" });
    const uploadHero = async (expectedProfileRevision: number) => {
      const assignmentIndex = media.assignmentRequests.length;
      const uploadNumber = media.uploadSessionRequests.length + 1;
      await heroInput.setInputFiles(HERO_PNG_FILE);
      await expectHeroAssigned(media, assignmentIndex, uploadNumber, expectedProfileRevision);
      const url = media.heroUrl(uploadNumber);
      await expect(heroImage).toHaveAttribute("src", url);
      await expect(heroImage).toBeVisible();
      await expect
        .poll(() => designRequests.some(({ body }) => body?.heroImage === url))
        .toBe(true);
    };

    await expect(page.getByText("Click to upload")).toBeVisible();
    await uploadHero(4);
    await page.screenshot({ path: test.info().outputPath("hero-uploaded.png") });
    await uploadHero(5);

    await heroInput.setInputFiles({ name: "hero.gif", mimeType: "image/gif", buffer: HERO_PNG });
    await expect(
      page.getByText("Hero images must be JPG, PNG, or WebP files up to 10 MB."),
    ).toBeVisible();
    expect(media.uploadSessionRequests).toHaveLength(2);

    media.rejectNextAssignment();
    await heroInput.setInputFiles(HERO_PNG_FILE);
    await expect(page.getByText("Image upload failed. Please try again.")).toBeVisible();
    await expect(heroImage).toHaveAttribute("src", media.heroUrl(2));
    await page.screenshot({ path: test.info().outputPath("hero-upload-failed.png") });
    const retryAssignmentIndex = media.assignmentRequests.length;
    const retryUploadNumber = media.uploadSessionRequests.length + 1;
    await tryAgain.click();
    await expectHeroAssigned(media, retryAssignmentIndex, retryUploadNumber, 7);
    await expect(heroImage).toHaveAttribute("src", media.heroUrl(retryUploadNumber));
    await expect(page.getByText("Image upload failed. Please try again.")).toHaveCount(0);

    media.failNextUploadSessions(3);
    await heroInput.setInputFiles(HERO_PNG_FILE);
    await expect(page.getByText("Image upload failed. Please try again.")).toBeVisible();
    await tryAgain.click();
    await expect(page.getByText("Image upload failed. Please try again.")).toBeVisible();
    await tryAgain.click();
    await expect(
      page.getByText(
        "Upload failed after multiple attempts. Please check your file and try again, or contact support.",
      ),
    ).toBeVisible();
    await expect(heroImage).toHaveAttribute("src", media.heroUrl(retryUploadNumber));
    await page.screenshot({ path: test.info().outputPath("hero-upload-failed-repeatedly.png") });

    // A new file starts a fresh count, and Try again recovers a revision lost while offline.
    media.failNextUploadSessions(1);
    media.failNextProfileReads(1);
    await heroInput.setInputFiles(HERO_PNG_FILE);
    await expect(page.getByText("Image upload failed. Please try again.")).toBeVisible();
    const recoveredAssignmentIndex = media.assignmentRequests.length;
    const recoveredUploadNumber = media.uploadSessionRequests.length + 1;
    await tryAgain.click();
    await expectHeroAssigned(media, recoveredAssignmentIndex, recoveredUploadNumber, 8);
    await expect(heroImage).toHaveAttribute("src", media.heroUrl(recoveredUploadNumber));
    await expect(page.getByText("1/10", { exact: true })).toBeVisible();
  });

  test("removes the canonical cover and loads the hero from it", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    const { requests: designRequests } = await mockBookingAdminDesignSettings(page, {
      ...defaultBookingAdminDesignSettings,
      heroImage: "",
    });
    const media = await mockCanonicalHeroMedia(page, { withCover: true });

    await page.goto("/design-studio");
    const heroImage = page.locator('img[alt="Hero"]');
    await expect(heroImage).toHaveAttribute("src", media.heroUrl(0));

    let confirmMessage = "";
    page.once("dialog", (dialog) => {
      confirmMessage = dialog.message();
      return dialog.accept();
    });
    await page.getByRole("button", { name: "Remove hero image" }).click();
    await expect(heroImage).toHaveCount(0);
    expect(confirmMessage).toBe("Remove the hero image from your booking page?");
    await expect.poll(() => media.assignmentRequests.length).toBe(1);
    expect(media.assignmentRequests[0]).toEqual({
      expectedProfileRevision: 4,
      assignments: [
        {
          mediaObjectId: HERO_GALLERY_PHOTO.mediaObjectId,
          role: "gallery",
          altText: HERO_GALLERY_PHOTO.altText,
          sortOrder: 0,
        },
      ],
    });
    await expect.poll(() => designRequests.some(({ body }) => body?.heroImage === "")).toBe(true);

    await page.getByTestId("hero-image-input").setInputFiles(HERO_PNG_FILE);
    await expectHeroAssigned(media, 1, 1, 5);
    await expect(heroImage).toHaveAttribute("src", media.heroUrl(1));
    await expect(heroImage).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("hero-re-uploaded.png") });
  });

  test("keeps Design Studio read-only until saved branding loads", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    let designReads = 0;
    await page.route("**/api/booking/hotels/*/settings/design", (route) => {
      designReads += 1;
      return designReads === 1
        ? route.fulfill({ status: 500, json: { message: "Unavailable" } })
        : route.fulfill({ json: defaultBookingAdminDesignSettings });
    });

    await page.goto("/design-studio");

    await expect(page.getByRole("heading", { name: "Design Studio" })).toBeVisible();
    await expect(
      page.getByText("Failed to load design settings. Your saved design has not been changed."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Changes" })).toHaveCount(0);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("textbox", { name: "Hero heading" })).toHaveValue(
      defaultBookingAdminDesignSettings.heroHeading,
    );
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  test("uploads, previews, and removes a Booking header logo", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    const { requests } = await mockBookingAdminDesignSettings(page);
    const logoUrls = [
      "https://media.example/alpenrose-header-logo.webp",
      "https://media.example/alpenrose-header-logo-replacement.webp",
    ];
    const logoMediaObjectIds = [
      "a1000000-0000-4000-8000-000000001217",
      "a1000000-0000-4000-8000-000000001218",
    ];
    let uploadCount = 0;

    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      const request = route.request();
      if (request.url().endsWith("/finalize")) {
        const logoIndex = Math.max(0, uploadCount - 1);
        const logoUrl = logoUrls[logoIndex]!;
        await route.fulfill({
          json: {
            mediaObjects: [
              {
                mediaId: logoMediaObjectIds[logoIndex],
                purpose: "booking.header_logo",
                visibility: "public",
                variants: [{ publicCdnUrl: logoUrl }],
              },
            ],
          },
        });
        return;
      }

      expect(request.postDataJSON()).toMatchObject({
        purpose: "booking.header_logo",
        visibility: "public",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: BOOKING_ADMIN_HOTEL_ID,
        },
        files: [{ contentType: "image/svg+xml" }],
      });
      uploadCount += 1;
      await route.fulfill({
        json: {
          uploadSession: { sessionId: `header-logo-session-${uploadCount}` },
          uploadTargets: [
            {
              uploadTargetId: `header-logo-target-${uploadCount}`,
              method: "PUT",
              uploadUrl: `https://uploads.vayada.localhost/header-logo-target-${uploadCount}`,
              headers: { "content-type": "image/svg+xml" },
            },
          ],
        },
      });
    });

    await page.goto("/design-studio");
    await page.locator('input[accept*="image/svg+xml"]').setInputFiles({
      name: "alpenrose.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect width="300" height="80" fill="white"/></svg>',
      ),
    });

    await expect(page.getByAltText("Header logo preview")).toHaveAttribute("src", logoUrls[0]!);
    await expect(page.getByAltText("Alpenrose logo")).toHaveAttribute("src", logoUrls[0]!);
    await expect
      .poll(
        () =>
          requests.find(
            (request) =>
              request.method === "PATCH" &&
              request.body?.headerLogoMediaObjectId === logoMediaObjectIds[0],
          )?.body?.headerLogoMediaObjectId,
      )
      .toBe(logoMediaObjectIds[0]);

    const replacement = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="72"><rect width="260" height="72" fill="navy"/></svg>',
          ],
          "alpenrose-replacement.svg",
          { type: "image/svg+xml" },
        ),
      );
      return transfer;
    });
    await page.getByTestId("header-logo-dropzone").dispatchEvent("drop", {
      dataTransfer: replacement,
    });
    await expect(page.getByAltText("Header logo preview")).toHaveAttribute("src", logoUrls[1]!);
    await expect(page.getByAltText("Alpenrose logo")).toHaveAttribute("src", logoUrls[1]!);

    await page.getByRole("button", { name: "Manage header logo" }).click();
    await page.getByRole("button", { name: "Remove logo" }).click();
    await expect(page.getByAltText("Header logo preview")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Alpenrose", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(
        () =>
          requests.filter((request) => request.method === "PATCH").at(-1)?.body
            ?.headerLogoMediaObjectId,
      )
      .toBeNull();
  });
});

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  };
}

// The setup page needs an AuthKit session whose user has a name, phone and photo; otherwise it
// shows the account-details gate first. The legacy-token mock alone gives no session user.
async function mockSetupOwnerSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: sharedCorsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
        workosOrganizationId: "org_workos_hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@alpenrose.example",
          name: "Hotel Owner",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.png",
          profilePictureMediaObjectId: "a1000000-0000-4000-8000-000000000777",
          status: "active",
        },
      },
    });
  });
}

const HERO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAFElEQVR4nGPgK5lAEmIY1TAoNAAAgOWaIUxSi4wAAAAASUVORK5CYII=",
  "base64",
);
const HERO_PNG_FILE = { name: "hero.png", mimeType: "image/png", buffer: HERO_PNG };
const HERO_GALLERY_PHOTO = {
  mediaObjectId: "a1000000-0000-4000-8000-000000002069",
  url: "https://media.example/gallery-pool.webp",
  altText: "Pool",
};

/** Mocks platform media and the canonical cover; upload N's hero is `heroUrl(N)`, 0 is a pre-existing cover. */
async function mockCanonicalHeroMedia(page: Page, { withCover = false } = {}) {
  const heroMediaObjectId = (uploadNumber: number) =>
    `a1000000-0000-4000-8000-${String(2060 + uploadNumber).padStart(12, "0")}`;
  const heroUrl = (uploadNumber: number) =>
    `https://media.example/${heroMediaObjectId(uploadNumber)}.png`;
  let profileRevision = 4;
  let publicMedia: Array<Record<string, unknown>> = [
    ...(withCover
      ? [
          {
            mediaObjectId: heroMediaObjectId(0),
            mediaType: "hero_image",
            url: heroUrl(0),
            altText: null,
            sortOrder: 0,
          },
        ]
      : []),
    { ...HERO_GALLERY_PHOTO, mediaType: "gallery_image", sortOrder: withCover ? 1 : 0 },
  ];
  let rejectedAssignments = 0;
  let failedUploadSessions = 0;
  let failedProfileReads = 0;
  const assignmentRequests: Array<Record<string, unknown>> = [];
  const uploadSessionRequests: Array<Record<string, unknown>> = [];

  // The uploader hides images that fail to load, so previews and hero URLs must be real images.
  await page.route("https://media.example/**", (route) =>
    route.fulfill({ contentType: "image/png", body: HERO_PNG }),
  );
  await page.route(`**${BOOKING_ADMIN_PUBLIC_PROPERTY_PROFILE_PATH}*`, (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }
    if (failedProfileReads > 0) {
      failedProfileReads -= 1;
      return route.fulfill({ status: 503, headers: corsHeaders(), json: { message: "Offline" } });
    }
    return route.fulfill({
      headers: corsHeaders(),
      json: {
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        profileRevision,
        publicProfile: {
          locale: "en",
          shortDescription: CANONICAL_PUBLIC_DESCRIPTION,
          longDescription: null,
          media: publicMedia,
        },
      },
    });
  });
  await page.route(
    `**/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/media/presentation`,
    (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: corsHeaders() });
      }
      const body = request.postDataJSON() as {
        assignments: Array<{
          mediaObjectId: string;
          role: "cover" | "gallery";
          altText: string | null;
          sortOrder: number;
        }>;
      };
      assignmentRequests.push(body);
      profileRevision += 1;
      if (rejectedAssignments > 0) {
        rejectedAssignments -= 1;
        return route.fulfill({
          status: 409,
          headers: corsHeaders(),
          json: { code: "profile_revision_conflict", currentRevision: profileRevision },
        });
      }
      publicMedia = body.assignments.map(({ mediaObjectId, role, altText, sortOrder }) => ({
        mediaObjectId,
        mediaType: role === "cover" ? "hero_image" : "gallery_image",
        url:
          role === "cover" ? `https://media.example/${mediaObjectId}.png` : HERO_GALLERY_PHOTO.url,
        altText,
        sortOrder,
      }));
      return route.fulfill({
        headers: corsHeaders(),
        json: {
          outcome: "updated",
          profileRevision,
          logoAssignment: null,
          presentationAssignments: body.assignments,
        },
      });
    },
  );
  await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }
    const uploadNumber = uploadSessionRequests.length;
    if (request.url().endsWith("/finalize")) {
      return route.fulfill({
        headers: corsHeaders(),
        json: {
          contractVersion: "platform-media-upload.v2",
          uploadSession: { sessionId: `hero-upload-${uploadNumber}`, status: "completed" },
          uploadTargets: [],
          mediaObjects: [
            {
              mediaObjectId: heroMediaObjectId(uploadNumber),
              purpose: "property.hero_image",
              status: "private_ready",
              publicVariants: [],
            },
          ],
        },
      });
    }
    if (failedUploadSessions > 0) {
      failedUploadSessions -= 1;
      return route.fulfill({
        status: 400,
        headers: corsHeaders(),
        json: { code: "invalid_upload_request", message: "Upload rejected." },
      });
    }
    uploadSessionRequests.push(request.postDataJSON() as Record<string, unknown>);
    // Real uploads outlast the local preview; an instant mock revokes it before it renders.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return route.fulfill({
      status: 201,
      headers: corsHeaders(),
      json: {
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: `hero-upload-${uploadNumber + 1}`, status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: `hero-target-${uploadNumber + 1}`,
            clientFileId: "file_1",
            method: "PUT",
            uploadUrl: `https://uploads.vayada.localhost/hero-upload-${uploadNumber + 1}`,
            headers: {},
          },
        ],
      },
    });
  });

  return {
    assignmentRequests,
    uploadSessionRequests,
    heroMediaObjectId,
    heroUrl,
    rejectNextAssignment: () => {
      rejectedAssignments = 1;
    },
    failNextUploadSessions: (count: number) => {
      failedUploadSessions = count;
    },
    failNextProfileReads: (count: number) => {
      failedProfileReads = count;
    },
  };
}

async function expectHeroAssigned(
  media: Awaited<ReturnType<typeof mockCanonicalHeroMedia>>,
  assignmentIndex: number,
  uploadNumber: number,
  expectedProfileRevision: number,
) {
  await expect.poll(() => media.assignmentRequests.length).toBeGreaterThan(assignmentIndex);
  const upload = media.uploadSessionRequests[uploadNumber - 1];
  expect(upload).toMatchObject({
    purpose: "property.hero_image",
    visibility: "private",
    resource: {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: BOOKING_ADMIN_PROPERTY_ID,
    },
  });
  expect(upload).not.toHaveProperty("expectedProfileRevision");
  expect(media.assignmentRequests[assignmentIndex]).toEqual({
    expectedProfileRevision,
    assignments: [
      {
        mediaObjectId: media.heroMediaObjectId(uploadNumber),
        role: "cover",
        altText: null,
        sortOrder: 0,
      },
      {
        mediaObjectId: HERO_GALLERY_PHOTO.mediaObjectId,
        role: "gallery",
        altText: HERO_GALLERY_PHOTO.altText,
        sortOrder: 1,
      },
    ],
  });
}
