import { expect, test, type Page, type Route } from "@playwright/test";

// VAY-2295: a Vayada operator moves a hotel's booking page to a new address on its Address tab
// (Flamur approved before/after screenshots instead of a Paper board, 2026-10-20). The preview
// writes nothing; the change names the previewed plan.
const propertyId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const planSha256 = "b".repeat(64);
const api = (path: string) =>
  new RegExp(`https://api\\.localhost(?::\\d+)?${path.replace(/[?]/g, "\\?")}(?:\\?.*)?$`);

async function fulfillJson(route: Route, origin: string, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function openHotel(page: Page, baseURL: string | undefined, hotelPath = propertyId) {
  const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
  const origin = new URL(adminBaseURL).origin;
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "e2e-platform-token");
    window.localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user_platform_admin");
    window.localStorage.setItem("userEmail", "platform-admin@example.test");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("isSuperAdmin", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({
        id: "user_platform_admin",
        email: "platform-admin@example.test",
        status: "active",
        is_superadmin: true,
      }),
    );
  });
  // The other tabs' reads answer empty; this spec is about the address.
  await page.route(/https:\/\/api\.localhost(?::\d+)?\/.*/, (route) =>
    fulfillJson(route, origin, {}),
  );
  await page.route(api("/api/platform/admin/growth"), (route) =>
    fulfillJson(route, origin, {
      properties: [
        {
          id: propertyId,
          name: "Hotel Alpenrose Munich",
          slug: "test-only-alpenrose",
          status: "live",
          lifecycleStatus: "active",
          lifecycleRevision: 4,
          ownerAccountUserIds: [],
          createdAt: "2026-08-13T12:00:00.000Z",
        },
      ],
    }),
  );
  await page.goto(new URL(`/dashboard/hotels/${hotelPath}`, adminBaseURL).toString());
  return origin;
}

async function openAddress(page: Page, baseURL: string | undefined) {
  const origin = await openHotel(page, baseURL);
  await expect(page.getByRole("heading", { name: "Hotel Alpenrose Munich" })).toBeVisible();
  await page.getByRole("button", { name: "Address", exact: true }).click();
  return origin;
}

const plan = {
  propertyId,
  fromSlug: "test-only-alpenrose",
  toSlug: "alpenrose",
  change: "new_address",
  livePage: {
    pageSlug: "test-only-alpenrose",
    organizationId: ownerId,
    republishAsUserId: ownerId,
  },
};

test("previews the new address, then moves the live page to it", async ({
  page,
  baseURL,
}, testInfo) => {
  const origin = await openAddress(page, baseURL);
  const card = page.getByRole("region", { name: "Booking page address" });
  await expect(card.getByText("test-only-alpenrose", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("address-form.png"), fullPage: true });

  const sent: Array<{ path: string; body: unknown }> = [];
  await page.route(api(`/api/platform/admin/properties/${propertyId}/slug/preview`), (route) => {
    sent.push({ path: "preview", body: route.request().postDataJSON() });
    return fulfillJson(route, origin, { plan, planSha256 });
  });
  await page.route(api(`/api/platform/admin/properties/${propertyId}/slug`), (route) => {
    sent.push({ path: "change", body: route.request().postDataJSON() });
    return fulfillJson(route, origin, {
      plan,
      planSha256,
      publication: { status: "succeeded", operationId: ownerId },
    });
  });

  const previewButton = card.getByRole("button", { name: "Preview the change" });
  await card.getByLabel("New address").fill("alpenrose");
  await expect(previewButton).toBeDisabled();
  await card.getByLabel("Reason").fill("Drop the test prefix");
  await previewButton.click();
  await expect(card.getByText("From test-only-alpenrose to alpenrose")).toBeVisible();
  await expect(
    card.getByText(/The live booking page is republished at the new address\./),
  ).toBeVisible();
  await expect(card.getByText("Plan bbbbbbbbbbbb")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("address-preview.png"), fullPage: true });

  await card.getByRole("button", { name: "Change address" }).click();
  await expect(card.getByRole("status")).toHaveText(
    "The booking page is now at alpenrose. test-only-alpenrose forwards guests to it.",
  );
  expect(sent).toEqual([
    { path: "preview", body: { slug: "alpenrose" } },
    {
      path: "change",
      body: { slug: "alpenrose", reason: "Drop the test prefix", expectedPlanSha256: planSha256 },
    },
  ]);
  await page.screenshot({ path: testInfo.outputPath("address-changed.png"), fullPage: true });
});

test("explains a refusal and keeps the form", async ({ page, baseURL }, testInfo) => {
  const origin = await openAddress(page, baseURL);
  const card = page.getByRole("region", { name: "Booking page address" });
  await page.route(api(`/api/platform/admin/properties/${propertyId}/slug/preview`), (route) =>
    fulfillJson(route, origin, { code: "slug_taken" }, 409),
  );
  await card.getByLabel("New address").fill("alpenrose");
  await card.getByLabel("Reason").fill("Drop the test prefix");
  await card.getByRole("button", { name: "Preview the change" }).click();
  await expect(card.getByRole("alert")).toHaveText("Another hotel already uses this address.");
  await expect(card.getByLabel("New address")).toHaveValue("alpenrose");
  await page.screenshot({ path: testInfo.outputPath("address-refused.png"), fullPage: true });
});

// A link pasted with a stray character (here a trailing ".") names no hotel: the page says so
// instead of showing tabs whose actions would fail (VAY-2295 follow-up).
test("a link to a hotel that doesn't exist says so", async ({ page, baseURL }, testInfo) => {
  await openHotel(page, baseURL, `${propertyId}.`);
  await expect(page.getByRole("heading", { name: "Hotel not found" })).toBeVisible();
  await expect(page.getByText("There's no hotel at this link.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Address", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("hotel-not-found.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to Hotels" }).click();
  await expect(page).toHaveURL(/\/dashboard\/hotels$/);
});
