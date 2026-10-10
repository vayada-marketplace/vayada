import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2078: the Feature Hub switches decide whether Inbox and Reviews show in the PMS sidebar.
async function setup(page: Page, options: { unavailable?: boolean } = {}) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-owner-membership",
        roleKey: "hotel_owner",
        permissions: [
          "pms.dashboard.read",
          "pms.reservation.read",
          "pms.inbox.read",
          "pms.operations.read",
          "pms.operations.manage",
          "pms.settings.read",
        ],
      },
    }),
  );
  const active = new Set<string>();
  await page.route(
    new RegExp(`/api/pms/properties/${PMS_WEB_PROPERTY_ID}/navigation-modules(?:/\\w+)?$`),
    (route) => {
      if (options.unavailable)
        return route.fulfill({ status: 503, json: { code: "navigation_modules_unavailable" } });
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as { moduleId: string; isActive: boolean };
        if (body.isActive) active.add(body.moduleId);
        else active.delete(body.moduleId);
        return route.fulfill({
          json: {
            ...body,
            activatedAt: null,
            deactivatedAt: null,
            updatedAt: "2026-10-09T00:00:00Z",
          },
        });
      }
      return route.fulfill({
        json: {
          hotelId: PMS_WEB_PROPERTY_ID,
          canManage: true,
          supportedModules: ["inbox", "reviews"],
          activeModules: Array.from(active),
          activations: [],
        },
      });
    },
  );
  let unreadReads = 0;
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/unread-count`,
    (route) => {
      unreadReads += 1;
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          threadCount: 2,
          messageCount: 3,
        },
      });
    },
  );
  return { unreadReads: () => unreadReads };
}

function sidebarLinks(page: Page) {
  return page
    .getByRole("navigation")
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
}

test("adds and removes Inbox and Reviews in the sidebar as the Feature Hub switches them", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { unreadReads } = await setup(page);
  await page.goto("/settings/feature-hub");
  const navigation = page.getByRole("navigation");

  await expect(navigation.getByRole("link", { name: /Reservations/ })).toBeVisible();
  await expect(navigation.getByRole("link", { name: /Inbox/ })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: /Reviews/ })).toHaveCount(0);
  // A hidden Inbox has no badge; its unread guests surface in the notice instead (VAY-2078 b).
  await expect(
    page.getByRole("status").filter({ hasText: "You have 3 unread guest messages." }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sidebar-modules-off.png") });

  await page.getByRole("switch", { name: "Activate Inbox" }).click();
  await expect(navigation.getByRole("link", { name: /Inbox/ })).toBeVisible();
  await page.getByRole("switch", { name: "Activate Reviews" }).click();
  await expect(navigation.getByRole("link", { name: /Reviews/ })).toBeVisible();
  const order = await sidebarLinks(page);
  expect(order.indexOf("/inbox")).toBe(order.indexOf("/bookings") + 1);
  expect(order.indexOf("/reviews")).toBe(order.indexOf("/inbox") + 1);
  await expect.poll(unreadReads).toBeGreaterThan(0);
  await expect(navigation.getByRole("link", { name: /Inbox/ })).toContainText("2");
  await page.screenshot({ path: testInfo.outputPath("sidebar-modules-on.png") });

  await page.getByRole("switch", { name: "Deactivate Inbox" }).click();
  await expect(navigation.getByRole("link", { name: /Inbox/ })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: /Reviews/ })).toBeVisible();

  // Hiding the item never blocks the page itself.
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(navigation.getByRole("link", { name: /Inbox/ })).toHaveCount(0);
});

test("keeps Inbox and Reviews in the sidebar when the switches cannot be read", async ({
  page,
}) => {
  await setup(page, { unavailable: true });
  await page.goto("/dashboard");
  const navigation = page.getByRole("navigation");

  await expect(navigation.getByRole("link", { name: /Inbox/ })).toBeVisible();
  await expect(navigation.getByRole("link", { name: /Reviews/ })).toBeVisible();
});
