import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
test("guest review preview, failure, uncertainty and durable acceptance", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  let state = "ready",
    sends = 0;
  let draft: unknown;
  const item = () => ({
    reviewId: "guest-review",
    guestName: "Synthetic Ada",
    reservationCode: "HM-TEST",
    state,
    draft,
    reason: state === "failed" ? "future_reason" : undefined,
  });
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/guest-reviews`;
  await page.route(`${base}?*`, (route) =>
    route.fulfill({
      json: {
        items: [{ ...item(), state: "ready" }],
        stored: draft ? [item()] : [],
        more: false,
        unavailable: false,
      },
    }),
  );
  await page.route(`${base}/guest-review`, (route) => {
    if (route.request().method() === "POST") {
      sends++;
      draft = route.request().postDataJSON();
      state = sends === 1 ? "failed" : "uncertain";
      if (sends === 2) return route.abort("failed");
    }
    return route.fulfill({ json: item() });
  });
  await page.goto("/reviews");
  await page.getByRole("button", { name: "Load guest reviews" }).click();
  await expect(page.getByText("Synthetic Ada · HM-TEST")).toBeVisible();
  await page.getByRole("button", { name: "Check eligibility / status" }).click();
  const preview = page.getByRole("button", { name: "Review before sending" });
  await expect(preview).toBeDisabled();
  for (const name of ["House rules", "Communication", "Cleanliness"])
    await page.getByLabel(name, { exact: true }).selectOption("5");
  await page.getByLabel("Public review (required)").fill("A considerate guest.");
  await page.getByLabel("Private feedback to guest (optional)").fill("Thank you, Ada.");
  await preview.click();
  expect(sends).toBe(0);
  await expect(page.getByLabel("Public review (required)")).toBeDisabled();
  await page.getByRole("button", { name: "Send guest review", exact: true }).click();
  await expect(page.getByText("Submission rejected.", { exact: false })).toBeVisible();
  await expect(page.getByText("Unable to check Channex. Your input is preserved.")).toBeVisible();
  await page.getByLabel("Public review (required)").fill("A very considerate guest.");
  await preview.click();
  await page.getByRole("button", { name: "Send guest review", exact: true }).click();
  await expect(page.getByText("Submission is unconfirmed.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Check eligibility / status" }).click();
  expect(sends).toBe(2);
  await expect(page.getByRole("button", { name: "Send guest review", exact: true })).toHaveCount(0);
  state = "accepted";
  await page.getByRole("button", { name: "Check eligibility / status" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Load guest reviews" }).click();
  await expect(page.getByText("Submitted to Airbnb.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Public review (required)")).toHaveValue(
    "A very considerate guest.",
  );
  await expect(page.getByRole("button", { name: "Send guest review", exact: true })).toHaveCount(0);
  expect(sends).toBe(2);
});

test("guest-review discovery retries the same page after unavailable response", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const pages: string[] = [];
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/guest-reviews?*`, (route) => {
    pages.push(new URL(route.request().url()).searchParams.get("page")!);
    return route.fulfill({
      json: { items: [], stored: [], more: false, unavailable: pages.length === 1 },
    });
  });
  await page.goto("/reviews");
  await page.getByRole("button", { name: "Load guest reviews" }).click();
  await expect(page.getByText("Guest reviews are unavailable.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Load guest reviews" }).click();
  await expect(page.getByText("No opportunities returned on this page.")).toBeVisible();
  expect(pages).toEqual(["1", "1"]);
});
