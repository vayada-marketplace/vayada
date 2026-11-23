import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";
import { chatView, routeAssistant } from "../support/assistantMocks";

// VAY-2519: the in-app assistant's panel in Booking Admin, as on the approved Paper boards (VAY-2517).
test.use({ viewport: { width: 1440, height: 900 } });

async function setup(page: Page) {
  await mockBookingAdminAuthenticatedSession(page);
  await page.addInitScript(() => window.localStorage.setItem("userName", "Alex Meyer"));
  await mockBookingAdminShellRoutes(page);
}

const panelOf = (page: Page) => page.getByRole("complementary", { name: "Assistant" });

test("shows no Ask AI while the assistant is switched off", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const probe = page.waitForResponse(/\/api\/ai\/assistant\/conversations\?/);
  await page.goto("/dashboard");
  expect((await probe).status()).toBe(404);
  await expect(page.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
  await healthy();
});

test("asks about the selected property as Booking Admin and shows the answer beside the page", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const question = "How many page views did we have this week?";
  const answer = "Your booking page had 312 views this week, 18% more than last week.";
  const seen = await routeAssistant(page, {
    answer: (request) => ({
      events: [
        { type: "turn", conversationId: "c-ba", turnId: "c-ba-turn-1" },
        { type: "tool", toolCallId: "p", name: "properties_list", status: "ok" },
        { type: "text", text: answer },
        { type: "end", status: "done", reason: null },
      ],
      stored: chatView("c-ba", [
        { question: request.question, tools: [{ name: "properties_list", result: "ok" }], answer },
      ]),
    }),
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: "Hi Alex, what do you need?" })).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.width)).toBe(420);
  expect(Math.round(box.x + box.width)).toBe(1440);

  await panel.getByRole("textbox").fill(question);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText(answer)).toBeVisible();
  await expect(panel.getByText("Looked at your properties")).toBeVisible();
  expect(seen.turns).toEqual([
    { propertyId: BOOKING_ADMIN_PROPERTY_ID, app: "booking_admin", question },
  ]);
  expect(seen.lists[0]?.searchParams.get("app")).toBe("booking_admin");
  await page.screenshot({ path: testInfo.outputPath("06-booking-admin-answer.png") });
  await healthy();
});
