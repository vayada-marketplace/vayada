import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

test("review replies preserve failures, reconcile uncertainty and survive reload", async ({
  page,
}, testInfo) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  let state = "ready";
  let draft = "";
  let sends = 0;
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reviews`;
  await page.route(`${base}?*`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            reviewId: "review-1",
            channel: "booking.com",
            guestDisplayName: "Synthetic guest",
            body: "Lovely stay",
            rating: "9",
            replyBody: null,
            reviewedAt: null,
            updatedAt: "2026-09-07",
            replySubmission: state === "ready" ? null : { state, draft },
          },
        ],
        pagination: { total: 1, offset: 0, limit: 50 },
      },
    }),
  );
  await page.route(`${base}/review-1/reply`, (route) => {
    if (route.request().method() === "POST") {
      sends++;
      if (sends !== 2) draft = route.request().postDataJSON().text;
      state = sends === 1 ? "failed" : sends === 2 ? "unavailable" : "uncertain";
    }
    return route.fulfill({
      json: { state, draft, reason: state === "failed" ? "future_reason" : undefined },
    });
  });
  await page.goto("/reviews");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const send = page.getByRole("button", { name: "Submit response", exact: true });
  await expect(send).toBeDisabled();
  await page.getByLabel("Your public response").fill("Thank you for staying with us.");
  await send.click();
  await expect(page.getByText("Reply was rejected.", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Could not confirm status. Try Check status or verify in the channel."),
  ).toBeVisible();
  await expect(page.getByLabel("Your public response")).toHaveValue(draft);
  await page.getByLabel("Your public response").fill("Thank you again for staying with us.");
  await send.click();
  await expect(page.getByText("Reply unavailable.", { exact: true })).toBeVisible();
  state = "ready";
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByLabel("Your public response")).toHaveValue(
    "Thank you again for staying with us.",
  );
  await send.click();
  await expect(page.getByText("Submission outcome is uncertain.", { exact: false })).toBeVisible();
  await expect(send).toHaveCount(0);
  const statusResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && response.url().includes("/reviews/review-1/reply"),
  );
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await statusResponse;
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
  expect(sends).toBe(3);
  state = "accepted";
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(
    page.getByText("Response accepted by the provider.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Response accepted by the provider.", { exact: false }),
  ).toBeVisible();
  expect(sends).toBe(3);
  await expect(page.getByText("Submitted response", { exact: true })).toBeVisible();
  await expect(page.getByText(draft, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("review-reply.png") });
});
