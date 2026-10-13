import { expect, test, type Page } from "@playwright/test";

import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

// VAY-2153: the collaboration status colours live in lib/constants/colors.ts. When
// Tailwind did not scan lib/, they were never generated and the chat status badges
// rendered without a background.
const CONVERSATIONS = [
  { partner: "Pending Lodge", status: "pending", tab: "Active" },
  { partner: "Negotiating Inn", status: "negotiating", tab: "Active" },
  { partner: "Accepted Resort", status: "accepted", tab: "Active" },
  { partner: "Active Villa", status: "active", tab: "Active" },
  { partner: "Rejected Motel", status: "rejected", tab: "Archived" },
  { partner: "Declined Hostel", status: "declined", tab: "Archived" },
];

const TRANSPARENT = "rgba(0, 0, 0, 0)";

test("gives each collaboration status badge in the chat list its own background", async ({
  page,
}, testInfo) => {
  await primeCreatorSession(page);
  await routeJson(page, /\/api\/marketplace\/collaborations\/me(?:\?|$)/, {
    contractVersion: "marketplace-collaboration-reads.v1",
    authorizationMode: "creator_workspace_resource_link",
    items: [],
  });
  await routeJson(page, /\/api\/marketplace\/collaborations\/conversations(?:\?|$)/, {
    contractVersion: "marketplace-collaboration-reads.v1",
    items: CONVERSATIONS.map(({ partner, status }, index) => ({
      contractVersion: "marketplace-collaboration-reads.v1",
      collaborationId: `collaboration-${status}`,
      side: "creator",
      partnerName: partner,
      partnerAvatarUrl: null,
      offerTitle: null,
      collaborationStatus: status,
      lastMessageContent: `Hello from ${partner}`,
      lastMessageAt: `2026-10-0${index + 1}T10:00:00.000Z`,
      unreadCount: 0,
    })),
    nextCursor: null,
    hasMore: false,
  });

  await page.goto("/chat");
  const colors: Record<string, string> = {};
  for (const tab of ["Active", "Archived"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    const conversations = CONVERSATIONS.filter((conversation) => conversation.tab === tab);
    for (const { partner, status } of conversations) {
      const badge = page
        .locator("div.cursor-pointer")
        .filter({ has: page.getByRole("heading", { name: partner, exact: true }) })
        .getByText(status, { exact: true });
      await expect(badge).toBeVisible();
      if (status === conversations.at(-1)?.status) {
        await badge.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`chat-status-${tab.toLowerCase()}.png`),
        });
      }
      await expect(badge, `${status} badge has a background`).not.toHaveCSS(
        "background-color",
        TRANSPARENT,
      );
      colors[status] = await badge.evaluate((element) => getComputedStyle(element).backgroundColor);
    }
    // After this tab's rows are visible, the other tab's rows must be hidden.
    for (const { partner } of CONVERSATIONS.filter((conversation) => conversation.tab !== tab)) {
      await expect(page.getByRole("heading", { name: partner, exact: true })).toHaveCount(0);
    }
  }
  const distinct = ["pending", "negotiating", "accepted", "declined"].map(
    (status) => colors[status],
  );
  expect(new Set(distinct).size, `status colours ${JSON.stringify(colors)}`).toBe(4);
  // VAY-2153: active and rejected used to fall back to pending's yellow.
  expect(colors.active, "active looks accepted").toBe(colors.accepted);
  expect(colors.rejected, "rejected looks declined").toBe(colors.declined);
});

async function primeCreatorSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("userType", "creator");
    localStorage.setItem("userName", "Lina Creator");
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem(
      "vayada_cookie_consent",
      // pending: false means the choice is already synced, so no consent POST is sent.
      JSON.stringify({
        necessary: true,
        functional: true,
        analytics: false,
        marketing: false,
        pending: false,
      }),
    );
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "creator-authkit-token",
        csrfToken: "creator-csrf-token",
        organizationId: "22222222-2222-4222-8222-222222222222",
        organizationKind: "creator_workspace",
        user: {
          id: "user-creator-e2e",
          email: "creator@example.test",
          name: "Lina Creator",
          status: "active",
        },
      },
    });
  });
}

async function routeJson(page: Page, pattern: RegExp, json: unknown) {
  await page.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json });
  });
}
