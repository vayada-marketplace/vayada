import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

// VAY-2078 decision (b): while Inbox is switched off, unread guest messages get a notice.
async function setup(
  page: Page,
  options: { permissions: string[]; canManage: boolean; inboxOn?: boolean; unread?: number },
) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "pms-member",
        roleKey: options.canManage ? "hotel_owner" : "front_desk",
        permissions: options.permissions,
      },
    }),
  );
  const active = new Set(options.inboxOn ? ["inbox"] : []);
  await page.route(
    new RegExp(`/api/pms/properties/${PMS_WEB_PROPERTY_ID}/navigation-modules(?:/\\w+)?$`),
    (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as { moduleId: string; isActive: boolean };
        if (body.isActive) active.add(body.moduleId);
        else active.delete(body.moduleId);
        return route.fulfill({
          json: {
            ...body,
            activatedAt: null,
            deactivatedAt: null,
            updatedAt: "2026-10-10T00:00:00Z",
          },
        });
      }
      return route.fulfill({
        json: {
          hotelId: PMS_WEB_PROPERTY_ID,
          canManage: options.canManage,
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
          threadCount: options.unread ?? 2,
          messageCount: options.unread ?? 2,
        },
      });
    },
  );
  return { unreadReads: () => unreadReads };
}

const notice = (page: Page) => page.getByRole("status").filter({ hasText: "unread guest message" });

test("lets an owner turn Inbox on from the notice, which then disappears", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page, {
    canManage: true,
    permissions: [
      "pms.dashboard.read",
      "pms.reservation.read",
      "pms.inbox.read",
      "pms.operations.read",
      "pms.operations.manage",
      "pms.settings.read",
    ],
  });
  await page.goto("/dashboard");

  await expect(notice(page)).toContainText("You have 2 unread guest messages.");
  await expect(page.getByRole("navigation").getByRole("link", { name: /Inbox/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inbox-notice-owner.png") });

  await notice(page).getByRole("link", { name: "Turn on Inbox" }).click();
  await expect(page).toHaveURL(/\/settings\/feature-hub$/);
  await page.getByRole("switch", { name: "Activate Inbox" }).click();
  await expect(page.getByRole("navigation").getByRole("link", { name: /Inbox/ })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test("shows front desk staff the notice without a switch", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, {
    canManage: false,
    permissions: ["pms.dashboard.read", "pms.reservation.read", "pms.inbox.read"],
    unread: 1,
  });
  await page.goto("/dashboard");

  await expect(notice(page)).toContainText("You have 1 unread guest message.");
  await expect(notice(page)).toContainText(
    "An owner or operator can turn on Inbox in the Feature Hub.",
  );
  await expect(notice(page).getByRole("link")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inbox-notice-front-desk.png") });

  // The Inbox page stays reachable by link; the notice gives way there.
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/inbox$/);
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);
});

test("stays quiet when Inbox is on, nothing is unread, or Inbox cannot be read", async ({
  page,
}) => {
  const owner = ["pms.dashboard.read", "pms.inbox.read", "pms.operations.manage"];
  const switchesRead = () => page.waitForResponse(/\/navigation-modules$/);
  const unreadRead = () => page.waitForResponse(/\/messaging\/unread-count$/);

  await setup(page, { canManage: true, permissions: owner, inboxOn: true });
  await Promise.all([switchesRead(), page.goto("/dashboard")]);
  await expect(page.getByRole("navigation").getByRole("link", { name: /Inbox/ })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setup(page, { canManage: true, permissions: owner, unread: 0 });
  await Promise.all([unreadRead(), page.goto("/dashboard")]);
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const { unreadReads } = await setup(page, {
    canManage: true,
    permissions: ["pms.dashboard.read", "pms.operations.manage"],
  });
  await Promise.all([switchesRead(), page.goto("/dashboard")]);
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);
  expect(unreadReads()).toBe(0);
});
