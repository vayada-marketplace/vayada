import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID as P,
  PMS_WEB_RESERVATION_ID as B,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation as baseReservation,
} from "../support/pmsWebMocks";

const pmsWebReservation = {
  ...baseReservation,
  source: "channel",
  assignments: baseReservation.assignments.map((assignment) => ({
    ...assignment,
    channel: "booking_com",
  })),
};

for (const report of [false, true]) {
  test(`records a no-show with ${report ? "explicit reporting and fee choice" : "local-only choice"}`, async ({
    page,
  }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    let local = false,
      submissions = 0;
    let status = "not_reported";
    await page.route(`**/api/pms/properties/${P}/reservations/${B}`, (route) =>
      route.fulfill({
        json: { item: { ...pmsWebReservation, status: local ? "no_show" : "confirmed" } },
      }),
    );
    await page.route(`**/api/pms/properties/${P}/reservations/${B}/no-show`, async (route) => {
      expect(local).toBe(false);
      local = true;
      await route.fulfill({ json: { reservation: { ...pmsWebReservation, status: "no_show" } } });
    });
    await page.route(
      `**/api/pms/properties/${P}/reservations/${B}/no-show-report`,
      async (route) => {
        if (route.request().method() === "POST") {
          expect(local).toBe(true);
          expect(route.request().postDataJSON()).toEqual({ waivedFees: false, retry: false });
          submissions++;
          status = "submitted";
        }
        await route.fulfill({
          json: {
            eligible: true,
            reason: null,
            localNoShow: local,
            status,
            retryable: false,
            waivedFees: submissions ? false : null,
          },
        });
      },
    );
    await page.goto(`/bookings/${B}`);
    await page.getByRole("button", { name: "Record no-show", exact: true }).click();
    if (report) {
      await page.getByRole("checkbox", { name: /Also report the entire/ }).check();
      await expect(page.getByRole("button", { name: "Confirm and report" })).toBeDisabled();
      await page.getByLabel("No-show fee choice", { exact: true }).selectOption("retain");
    }
    await page
      .getByRole("button", {
        name: report ? "Confirm and report" : "Record locally only",
        exact: true,
      })
      .click();
    await expect(
      page.getByText(
        report
          ? "Submitted to Channex — confirm Booking.com reporting in the extranet."
          : "Booking.com has not been notified by PMS.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText(
        report
          ? "Submitted to Channex — confirm Booking.com reporting in the extranet."
          : "Booking.com has not been notified by PMS.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(submissions).toBe(report ? 1 : 0);
    expect(local).toBe(true);
    await page.screenshot({
      path: `/tmp/vay1535-${report ? "submitted" : "local-only"}.png`,
      fullPage: true,
    });
  });
}

test("keeps an ineligible local no-show visible without offering unsafe delivery", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`**/api/pms/properties/${P}/reservations/${B}`, (route) =>
    route.fulfill({ json: { item: { ...pmsWebReservation, status: "no_show" } } }),
  );
  await page.route(`**/api/pms/properties/${P}/reservations/${B}/no-show-report`, (route) =>
    route.fulfill({
      json: {
        eligible: false,
        reason: "Partial no-shows require the extranet.",
        localNoShow: true,
        status: "not_reported",
        retryable: false,
        waivedFees: null,
      },
    }),
  );
  await page.goto(`/bookings/${B}`);
  await expect(page.getByText("Partial no-shows require the extranet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Report no-show to Booking.com" })).toBeDisabled();
});

test("keeps local no-show available when reporting status fails", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  let local = false;
  await page.route(`**/api/pms/properties/${P}/reservations/${B}`, (route) =>
    route.fulfill({
      json: { item: { ...pmsWebReservation, status: local ? "no_show" : "confirmed" } },
    }),
  );
  await page.route(`**/api/pms/properties/${P}/reservations/${B}/no-show-report`, (route) =>
    route.fulfill({ status: 503, json: { message: "Reporting unavailable" } }),
  );
  await page.route(`**/api/pms/properties/${P}/reservations/${B}/no-show`, async (route) => {
    expect(local).toBe(false);
    local = true;
    await route.fulfill({ json: { reservation: { ...pmsWebReservation, status: "no_show" } } });
  });
  await page.goto(`/bookings/${B}`);
  await page.getByRole("button", { name: "Record no-show", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Also report the entire/ })).toBeDisabled();
  await page.getByRole("button", { name: "Record locally only", exact: true }).click();
  await expect(
    page.getByText(
      "Local no-show saved. Reporting status is unavailable; Booking.com has not been notified by this action.",
    ),
  ).toBeVisible();
  expect(local).toBe(true);
});

test("does not deny reporting after submission succeeds but refreshed status fails", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  let requested = false;
  let failedRefreshRequested = false;
  await page.route(`**/api/pms/properties/${P}/reservations/${B}`, (route) =>
    route.fulfill({ json: { item: { ...pmsWebReservation, status: "no_show" } } }),
  );
  await page.route(`**/api/pms/properties/${P}/reservations/${B}/no-show-report`, async (route) => {
    if (route.request().method() === "POST") {
      requested = true;
      return route.fulfill({
        json: {
          eligible: true,
          reason: null,
          localNoShow: true,
          status: "pending",
          retryable: false,
          waivedFees: false,
        },
      });
    }
    if (requested) {
      failedRefreshRequested = true;
      return route.fulfill({ status: 503, json: { message: "Unavailable" } });
    }
    return route.fulfill({
      json: {
        eligible: true,
        reason: null,
        localNoShow: true,
        status: "not_reported",
        retryable: false,
        waivedFees: null,
      },
    });
  });
  await page.goto(`/bookings/${B}`);
  await page.getByRole("button", { name: "Report no-show to Booking.com" }).click();
  await page.getByRole("checkbox", { name: /Also report the entire/ }).check();
  await page.getByLabel("No-show fee choice", { exact: true }).selectOption("retain");
  await page.getByRole("button", { name: "Confirm and report" }).click();
  await expect(
    page.getByText("Report pending — Booking.com reporting is not confirmed."),
  ).toBeVisible();
  await expect.poll(() => failedRefreshRequested).toBe(true);
  await expect(page.getByText(/Booking.com has not been notified/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Report no-show to Booking.com" })).toHaveCount(0);
});

test("blocks a retry when the persisted fee choice is unavailable", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`**/api/pms/properties/${P}/reservations/${B}`, (route) =>
    route.fulfill({ json: { item: pmsWebReservation } }),
  );
  await page.route(`**/api/pms/properties/${P}/reservations/${B}/no-show-report`, (route) =>
    route.fulfill({
      json: {
        eligible: true,
        reason: null,
        localNoShow: true,
        status: "action_required",
        retryable: true,
        waivedFees: null,
      },
    }),
  );
  await page.goto(`/bookings/${B}`);
  await expect(page.getByText("Reporting needs attention.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry delivery with the same fee choice" }),
  ).toHaveCount(0);
});
