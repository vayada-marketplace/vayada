import { expect, test } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebInboxThread,
} from "../support/pmsWebMocks";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "membership_owner",
        roleKey: "hotel_manager",
        permissions: ["pms.inbox.read", "pms.inbox.reply", "pms.guest-contact.read"],
      },
    }),
  );
});

for (const [action, label] of [
  ["channex_close", "Close in Channex"],
  ["booking_com_no_reply_needed", "Tell Booking.com no reply is needed"],
] as const) {
  test(`${action} keeps pending, failure and confirmation distinct across reload`, async ({
    page,
  }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    let state = "";
    let posts = 0;
    await page.route("**/messaging/threads/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST" && url.pathname.includes("/provider-actions/")) {
        posts++;
        expect(route.request().postDataJSON()).toEqual({
          expectedVersion: pmsWebInboxThread.version,
        });
        state = "pending";
        return route.fulfill({
          status: 202,
          json: {
            contractVersion: "native-guest-inbox.v2",
            acceptedAt: "2026-09-07T00:00:00.000Z",
          },
        });
      }
      if (route.request().method() === "GET" && url.pathname.endsWith(`/${pmsWebInboxThread.id}`))
        return route.fulfill({
          json: {
            contractVersion: "native-guest-inbox.v2",
            thread: pmsWebInboxThread,
            availableProviderActions: !state || state === "failed" ? [action] : [],
            providerActions: state
              ? [
                  {
                    action,
                    state,
                    reason: state === "failed" ? "provider_rejected" : null,
                    threadVersion: pmsWebInboxThread.version,
                  },
                ]
              : [],
            timeline: [],
            previousCursor: null,
          },
        });
      return route.fallback();
    });
    const select = async () => {
      await page.goto("/inbox");
      await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
    };
    await select();
    await page.getByRole("button", { name: "More conversation actions" }).click();
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Pending provider confirmation" }),
    ).toBeVisible();
    await select();
    await expect(
      page.getByRole("status").filter({ hasText: "Pending provider confirmation" }),
    ).toBeVisible();
    state = "failed";
    await expect(page.getByRole("status").filter({ hasText: "Not completed" })).toBeVisible();
    await page.getByRole("button", { name: "More conversation actions" }).click();
    await page.getByRole("button", { name: label, exact: true }).click();
    state = "confirmed";
    await expect(
      page.getByRole("status").filter({ hasText: "Confirmed by provider" }),
    ).toBeVisible();
    await select();
    await expect(
      page.getByRole("status").filter({ hasText: "Confirmed by provider" }),
    ).toBeVisible();
    expect(posts).toBe(2);
  });
}

test("Airbnb pre-approval requires review and preserves uncertain status after reload", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  let posts = 0;
  test.setTimeout(75_000);
  let version = pmsWebInboxThread.version;
  await page.route("**/messaging/threads/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "POST" &&
      url.pathname.endsWith("/provider-actions/preapprove")
    ) {
      posts++;
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: version,
      });
      return route.fulfill({
        status: 202,
        json: { contractVersion: "native-guest-inbox.v2", acceptedAt: "2026-09-20T00:00:00.000Z" },
      });
    }
    if (route.request().method() === "GET" && url.pathname.endsWith(`/${pmsWebInboxThread.id}`))
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          thread: { ...pmsWebInboxThread, providerChannel: "airbnb", version },
          availableProviderActions: posts ? [] : ["airbnb_preapprove"],
          inquiryPreapproval: {
            listingId: "listing-123",
            arrivalDate: "2030-12-12",
            departureDate: "2030-12-15",
            adults: 2,
            children: 0,
            currency: "EUR",
          },
          providerActions: posts
            ? [
                {
                  action: "airbnb_preapprove",
                  state: "held",
                  reason: "ambiguous_provider_outcome",
                  threadVersion: pmsWebInboxThread.version,
                },
              ]
            : [],
          timeline: [],
          previousCursor: null,
        },
      });
    return route.fallback();
  });
  const select = async () => {
    await page.goto("/inbox");
    await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
  };
  await select();
  await page.getByRole("button", { name: "Pre-approve inquiry", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pre-approve inquiry" });
  await expect(dialog).toContainText("2030-12-12 – 2030-12-15");
  await expect(dialog).toContainText("current Airbnb price within 24 hours");
  await dialog.screenshot({ path: "/tmp/vay383-preapproval-dialog.png" });
  expect(posts).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "Pre-approve inquiry", exact: true }).click();
  version++;
  await expect(dialog.getByRole("button", { name: "Confirm pre-approval" })).toBeDisabled({
    timeout: 40_000,
  });
  await expect(dialog).toContainText("This conversation changed");
  expect(posts).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Pre-approve inquiry", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm pre-approval" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Airbnb pre-approval" })).toContainText(
    "This is not a confirmed booking",
  );
  await select();
  await expect(page.getByRole("button", { name: "Pre-approve inquiry", exact: true })).toHaveCount(
    0,
  );
  expect(posts).toBe(1);
});
