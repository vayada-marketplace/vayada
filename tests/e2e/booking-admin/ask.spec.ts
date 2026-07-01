import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_ORGANIZATION_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-admin Ask Intelligence", () => {
  test("asks a scoped question and renders the structured answer", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-ask");

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    await page.route("**/api/ai/ask", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-hotel-id"]).toBeUndefined();
      expect(route.request().postDataJSON()).toMatchObject({
        question: "Why did direct share change?",
        scope: {
          organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
          bookingHotelId: BOOKING_ADMIN_HOTEL_ID,
        },
      });
      await route.fulfill({
        json: {
          answerId: "ask_answer_e2e",
          generatedAt: "2026-06-19T00:00:00.000Z",
          question: "Why did direct share change?",
          status: "partial",
          summary: "Direct share softened because OTA bookings increased.",
          blocks: [
            {
              type: "metric",
              metricKey: "booking.direct_booking_share",
              value: 62.5,
              unit: "percentage",
              text: "Direct share is 62.5%.",
              evidenceIds: ["ev_share"],
            },
          ],
          unavailableData: [{ reason: "source_unavailable", canRetry: true }],
          caveats: [
            {
              code: "preliminary_revenue_mix",
              message: "Revenue source mix is preliminary.",
              evidenceIds: ["ev_share"],
            },
          ],
          suggestedActions: [
            {
              type: "view_report",
              label: "Review OTA campaign pacing.",
              evidenceIds: ["ev_share"],
            },
          ],
          followUpQuestions: ["Which dates drove the change?"],
          confidence: { level: "medium", reasons: [] },
        },
      });
    });

    await page.goto("/ask");
    await expect(page.getByRole("heading", { name: "Ask Intelligence" })).toBeVisible();

    await page.getByLabel("Question").fill("Why did direct share change?");
    const askButton = page.getByRole("button", { name: "Ask" });
    await expect(askButton).toBeEnabled();
    await askButton.click();

    await expect(page.getByRole("heading", { name: "Answer" })).toBeVisible();
    await expect(
      page.getByText("Direct share softened because OTA bookings increased."),
    ).toBeVisible();
    await expect(page.getByText("Direct share is 62.5%.")).toBeVisible();
    await expect(
      page.getByText("Required evidence is not loaded yet. Try again later."),
    ).toBeVisible();
    await expect(page.getByText("Revenue source mix is preliminary.")).toBeVisible();
    await expect(page.getByText("Review OTA campaign pacing.")).toBeVisible();
    await expect(page.getByText("booking.direct_booking_share")).toHaveCount(0);
    await expect(page.getByText("ev_share")).toHaveCount(0);

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
