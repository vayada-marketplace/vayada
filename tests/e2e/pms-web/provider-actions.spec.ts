import { expect, test } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebInboxThread,
} from "../support/pmsWebMocks";

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
