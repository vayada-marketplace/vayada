import { expect, test, type Page, type Route } from "@playwright/test";

import { mockFirstPartyAuth } from "../support/firstPartyAuth";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const alpenrose = {
  revisionId: "21690000-0000-4000-8000-000000000011",
  propertyId: "21690000-0000-4000-8000-000000000001",
  revisionNumber: 1,
  submittedAt: "2026-10-12T12:00:00.000Z",
  displayName: "Hotel Alpenrose Munich",
  propertyType: "hotel",
  city: "Munich",
  countryCode: "DE",
  previous: null,
  live: false,
};
const lumen = {
  revisionId: "21690000-0000-4000-8000-000000000022",
  propertyId: "21690000-0000-4000-8000-000000000002",
  revisionNumber: 2,
  submittedAt: "2026-10-13T12:00:00.000Z",
  displayName: "Casa Lumen",
  propertyType: "guesthouse",
  city: "Lisbon",
  countryCode: "PT",
  previous: { status: "changes_requested", decidedAt: "2026-10-11T12:00:00.000Z" },
  live: false,
};
const pixel =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><rect width='4' height='4' fill='%23dbeafe'/></svg>";

type Decision = { body: unknown; idempotencyKey?: string };

test("approves a hotel profile from the review queue and links to its public page", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const assertNoLegacyCalls = watchNoLegacyCalls(
    page,
    testInfo,
    "vayada-admin-marketplace-preview",
  );
  const { origin, adminBaseURL } = await openAdmin(page, baseURL);
  const queue = [alpenrose, lumen];
  const decisions: Decision[] = [];
  await routeQueue(page, origin, () => queue);
  await routeReview(page, origin);
  await routeDecision(page, origin, decisions, (revisionId, body) => {
    queue.splice(
      queue.findIndex((item) => item.revisionId === revisionId),
      1,
    );
    return { status: 200, body: decided(revisionId, body) };
  });

  await page.goto(new URL("/dashboard/marketplace", adminBaseURL).toString());
  await page.getByRole("button", { name: "Hotel reviews (2)" }).click();
  await expect(page.getByText("2 hotel profiles waiting for review")).toBeVisible();
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "Hotel Alpenrose Munich" })).toContainText("Munich, Germany");
  await expect(rows.filter({ hasText: "Hotel Alpenrose Munich" })).toContainText(
    "First submission",
  );
  await expect(rows.filter({ hasText: "Casa Lumen" })).toContainText("Resubmitted");
  await expect(rows.filter({ hasText: "Casa Lumen" })).toContainText("Changes requested");

  await page.getByRole("button", { name: "Review Hotel Alpenrose Munich" }).click();
  await expect(page.getByRole("heading", { name: "Review hotel profile" })).toBeVisible();
  await expect(page.getByText("by owner@example.com · First submission")).toBeVisible();
  await expect(page.getByText("Public profile preview")).toBeVisible();
  await expect(
    page.getByText("A family-run boutique hotel near the English Garden."),
  ).toBeVisible();
  await expect(page.getByText("Free stay, Paid")).toBeVisible();

  await page.getByRole("button", { name: "Approve and publish" }).click();
  const notice = page.getByRole("status").filter({ hasText: "is live on the Marketplace" });
  await expect(notice).toContainText("Hotel Alpenrose Munich is live on the Marketplace.");
  await expect(notice.getByRole("link", { name: "View public profile" })).toHaveAttribute(
    "href",
    new RegExp(`/hotels/${alpenrose.propertyId}$`),
  );
  await expect(page.getByRole("heading", { name: "Review hotel profile" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hotel reviews (1)" })).toBeVisible();
  await expect(page.getByText("1 hotel profile waiting for review")).toBeVisible();
  expect(decisions).toEqual([
    {
      body: { decision: "approve" },
      idempotencyKey: expect.stringMatching(
        new RegExp(`^marketplace\\.admin\\.hotel_submission\\.approve:${alpenrose.revisionId}:`),
      ),
    },
  ]);

  await assertNoLegacyCalls();
  await assertHealthy();
});

test("requests changes with a required note the hotel sees", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const { origin, adminBaseURL } = await openAdmin(page, baseURL);
  const queue = [lumen];
  const decisions: Decision[] = [];
  await routeQueue(page, origin, () => queue);
  await routeReview(page, origin);
  await routeDecision(page, origin, decisions, (revisionId, body) => {
    queue.length = 0;
    return { status: 200, body: decided(revisionId, body) };
  });

  await page.goto(new URL("/dashboard/marketplace", adminBaseURL).toString());
  await page.getByRole("button", { name: "Hotel reviews (1)" }).click();
  await page.getByRole("button", { name: "Review Casa Lumen" }).click();
  await expect(page.getByText("· Submission 2")).toBeVisible();
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(
    page.getByText("Casa Lumen can edit the profile and submit it again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send to hotel" }).click();
  await expect(page.getByText("Write a note so the hotel knows what to change.")).toBeVisible();
  expect(decisions).toEqual([]);

  const note = "Please use a photo of the guesthouse as the cover instead of the logo.";
  await page.getByLabel("Note to the hotel").fill(note);
  await expect(page.getByText(`${note.length}/1,000`)).toBeVisible();
  await page.getByRole("button", { name: "Send to hotel" }).click();
  await expect(
    page.getByText("Changes requested. Casa Lumen sees your note in setup."),
  ).toBeVisible();
  await expect(page.getByText("No hotel profiles are waiting for review")).toBeVisible();
  expect(decisions).toEqual([
    {
      body: { decision: "request_changes", note },
      idempotencyKey: expect.stringMatching(
        /^marketplace\.admin\.hotel_submission\.request_changes:/,
      ),
    },
  ]);

  await assertHealthy();
});

// The 409 is logged by the browser as a failed resource, so this test skips the page-health check.
test("refreshes the queue when another admin already decided", async ({ page, baseURL }) => {
  const { origin, adminBaseURL } = await openAdmin(page, baseURL);
  const queue = [alpenrose];
  let listCalls = 0;
  await routeQueue(page, origin, () => {
    listCalls += 1;
    return listCalls === 1 ? queue : [];
  });
  await routeReview(page, origin);
  await routeDecision(page, origin, [], () => ({
    status: 409,
    body: { statusCode: 409, code: "submission_already_decided", message: "conflict" },
  }));

  await page.goto(new URL("/dashboard/marketplace", adminBaseURL).toString());
  await page.getByRole("button", { name: "Hotel reviews (1)" }).click();
  await page.getByRole("button", { name: "Review Hotel Alpenrose Munich" }).click();
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(
    page.getByText(
      "Another admin already decided on this submission. The list has been refreshed.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Hotel reviews (0)" })).toBeVisible();
});

test("keeps Approve off when the public preview can't be shown", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const { origin, adminBaseURL } = await openAdmin(page, baseURL);
  await routeQueue(page, origin, () => [alpenrose]);
  await routeReview(page, origin, false);

  await page.goto(new URL("/dashboard/marketplace", adminBaseURL).toString());
  await page.getByRole("button", { name: "Hotel reviews (1)" }).click();
  await page.getByRole("button", { name: "Review Hotel Alpenrose Munich" }).click();
  await expect(page.getByText("The public preview can’t be shown")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and publish" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Request changes" })).toBeEnabled();

  await assertHealthy();
});

async function openAdmin(page: Page, baseURL: string | undefined) {
  const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
  const origin = new URL(adminBaseURL).origin;
  await mockFirstPartyAuth(page, {
    baseURL: adminBaseURL,
    key: "admin",
    label: "Vayada Admin",
    surface: "platform-admin",
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "e2e-platform-token");
    window.localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user-platform-admin");
    window.localStorage.setItem("userEmail", "platform-admin@example.test");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("isSuperAdmin", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({
        id: "user-platform-admin",
        email: "platform-admin@example.test",
        status: "active",
        is_superadmin: true,
      }),
    );
  });
  for (const path of ["offers", "creators"])
    await page.route(api(`/api/marketplace/${path}(?:\\?|$)`), async (route) => {
      if (await fulfillPreflight(route, origin)) return;
      await fulfillJson(route, origin, {
        items: [],
        pagination: { limit: 200, offset: 0, total: 0 },
      });
    });
  return { origin, adminBaseURL };
}

async function routeQueue(page: Page, origin: string, items: () => object[]) {
  await page.route(api("/api/marketplace/admin/hotel-submissions$"), async (route) => {
    if (await fulfillPreflight(route, origin)) return;
    await fulfillJson(route, origin, {
      contractVersion: "marketplace-hotel-submission-moderation.v1",
      submissions: items(),
    });
  });
}

async function routeReview(page: Page, origin: string, withPreview = true) {
  await page.route(api("/api/marketplace/admin/hotel-submissions/[0-9a-f-]+$"), async (route) => {
    if (await fulfillPreflight(route, origin)) return;
    const revisionId = route.request().url().split("/").pop()!;
    const item = [alpenrose, lumen].find((candidate) => candidate.revisionId === revisionId)!;
    await fulfillJson(route, origin, {
      contractVersion: "marketplace-hotel-submission-moderation.v1",
      review: {
        revisionId,
        propertyId: item.propertyId,
        revisionNumber: item.revisionNumber,
        status: "pending",
        submittedAt: item.submittedAt,
        submittedByEmail: "owner@example.com",
        preview: !withPreview
          ? null
          : {
              propertyId: item.propertyId,
              revisionId,
              displayName: item.displayName,
              propertyType: item.propertyType,
              shortDescription: "A family-run boutique hotel near the English Garden.",
              locality: { city: item.city, countryCode: item.countryCode },
              media: [
                { mediaType: "logo", url: pixel, altText: "Logo" },
                { mediaType: "hero_image", url: pixel, altText: "Cover" },
              ],
            },
        preferences: {
          compensationTypes: ["free_stay", "paid"],
          contentPlatforms: ["instagram", "tiktok"],
          contentTypes: ["short_form_video", "story"],
          availability: { mode: "year_round", selectedMonths: [] },
        },
        history: [],
        live: null,
      },
    });
  });
}

async function routeDecision(
  page: Page,
  origin: string,
  decisions: Decision[],
  respond: (revisionId: string, body: unknown) => { status: number; body: unknown },
) {
  await page.route(
    api("/api/marketplace/admin/hotel-submissions/[0-9a-f-]+/decision$"),
    async (route) => {
      if (await fulfillPreflight(route, origin)) return;
      const body = route.request().postDataJSON();
      const revisionId = route.request().url().split("/").at(-2)!;
      decisions.push({ body, idempotencyKey: route.request().headers()["idempotency-key"] });
      const reply = respond(revisionId, body);
      await fulfillJson(route, origin, reply.body, reply.status);
    },
  );
}

function decided(revisionId: string, body: unknown) {
  const item = [alpenrose, lumen].find((candidate) => candidate.revisionId === revisionId)!;
  const approve = (body as { decision: string }).decision === "approve";
  return {
    contractVersion: "marketplace-hotel-submission-moderation.v1",
    revisionId,
    propertyId: item.propertyId,
    revisionNumber: item.revisionNumber,
    status: approve ? "approved" : "changes_requested",
    note: approve ? null : (body as { note: string }).note,
    decidedByUserId: "user-platform-admin",
    decidedAt: "2026-10-14T10:00:00.000Z",
    publicPath: approve ? `/hotels/${item.propertyId}` : null,
  };
}

function api(path: string) {
  return new RegExp(`https://api\\.localhost(?::\\d+)?${path}`);
}

async function fulfillPreflight(route: Route, origin: string): Promise<boolean> {
  if (route.request().method() !== "OPTIONS") return false;
  await route.fulfill({ status: 204, headers: corsHeaders(origin) });
  return true;
}

async function fulfillJson(route: Route, origin: string, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}
