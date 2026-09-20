import { expect, test } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  pmsWebChannexSnapshot,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

test.beforeEach(async ({ page }) => {
  const token = "a".repeat(64);
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2`, (route) =>
    route.fulfill({ json: {
      currency: "EUR", revision: 1, stale: false,
      ownerReferences: { finance: `finance.pricing.v2:${token}` },
      sources: { room: `pms.pricing.rooms.v2:${token}`, terms: `booking.pricing.terms.v2:${token}`, finance: `finance.pricing.source.v2:${token}` },
      rooms: [{
        version: "pricing.v2", propertyId: PMS_WEB_PROPERTY_ID, roomTypeId: PMS_WEB_PROPERTY_ID,
        revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 0 },
        children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
        offers: [{
          id: "flex", termsRevision: "61000000-0000-4000-8000-000000000002",
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
          restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] },
        }],
      }],
    } }),
  );
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "test-owner",
        roleKey: "hotel_owner",
        permissions: ["pms.operations.read", "pms.operations.manage"],
      },
    }),
  );
});

const routeBase = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex`;

test("shows guarded target state and disables observe-only controls", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);

  await page.goto("/channel-manager");

  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(page.getByText(/observe-only mode/i)).toBeVisible();
  await expect(page.getByText("No provider mappings yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable connection" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Provision" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open channel settings" })).toBeDisabled();
  await assertHealthy();
});

test("does not allow stale markup edits while disconnected", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.unroute(routeBase);
  await page.route(routeBase, (route) =>
    route.fulfill({
      json: {
        ...pmsWebChannexSnapshot,
        markups: [{ channel: "booking_com", markupPercent: 12 }],
        capabilityModes: Object.fromEntries(
          Object.keys(pmsWebChannexSnapshot.capabilityModes).map((capability) => [
            capability,
            "mutating",
          ]),
        ),
      },
    }),
  );

  await page.goto("/channel-manager");

  await expect(page.getByRole("spinbutton")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save markups" })).toBeDisabled();
  await assertHealthy();
});

test("runs a durable sync and shows connected channel management", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);

  const snapshot = {
    ...pmsWebChannexSnapshot,
    connection: {
      status: "connected",
      externalPropertyId: "channex-property-1",
      messagingAppInstalled: false,
    },
    mappings: {
      roomTypes: [
        {
          mappingId: "mapping-room-1",
          roomTypeId: "room-type-1",
          roomTypeName: "Alpine Suite",
          externalRoomTypeId: "channex-room-1",
          status: "active",
        },
      ],
      ratePlans: [],
    },
    channels: [
      {
        key: "booking_com",
        application: "BookingCom",
        title: "Booking.com",
        isActive: true,
      },
    ],
    markups: [{ channel: "booking_com", markupPercent: 12 }],
    capabilityModes: Object.fromEntries(
      Object.keys(pmsWebChannexSnapshot.capabilityModes).map((capability) => [
        capability,
        "mutating",
      ]),
    ),
  };
  let commandBody: Record<string, unknown> | null = null;
  let markupBody: Record<string, unknown> | null = null;
  let operationReads = 0;

  await page.unroute(routeBase);
  await page.route(routeBase, (route) => route.fulfill({ json: snapshot }));
  await page.route(`${routeBase}/commands`, (route) => {
    commandBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ json: operation("queued") });
  });
  await page.route(`${routeBase}/markups`, (route) => {
    markupBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ json: operation("succeeded", "update_markups") });
  });
  await page.route(`${routeBase}/operations/operation-1`, (route) => {
    operationReads += 1;
    return route.fulfill({ json: operation(operationReads === 1 ? "running" : "succeeded") });
  });

  await page.goto("/channel-manager");

  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.getByText("Alpine Suite")).toBeVisible();
  await expect(page.getByText("Booking.com", { exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton")).toHaveValue("12");

  await page.getByRole("spinbutton").fill("13");
  await page.getByRole("button", { name: "Save markups" }).click();
  await expect
    .poll(() => markupBody?.["markups"])
    .toEqual([{ channel: "booking_com", markupPercent: 13 }]);

  await page.getByRole("button", { name: "Sync now" }).first().click();

  await expect.poll(() => commandBody?.["operationType"]).toBe("sync_ari");
  await expect(page.getByText(/sync ari: queued/i)).toBeVisible();
  await expect.poll(() => operationReads).toBe(2);
  await assertHealthy();
});

function operation(
  status: "queued" | "running" | "succeeded",
  operationType: "sync_ari" | "update_markups" = "sync_ari",
) {
  return {
    contractVersion: "pms-channex-management.v1",
    operationId: "operation-1",
    propertyId: PMS_WEB_PROPERTY_ID,
    operationType,
    status,
    commandId: "command-1",
    idempotencyKey: "sync_ari:command-1",
    acceptedAt: "2026-08-13T18:00:00.000Z",
    attemptsMade: status === "queued" ? 0 : 1,
    maxAttempts: 5,
    retryAfter: null,
    lastError: null,
  };
}

test("guides mapping recovery and keeps seen or queued alerts open", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.unroute(routeBase);
  await page.route(routeBase, (route) =>
    route.fulfill({
      json: {
        ...pmsWebChannexSnapshot,
        connection: {
          status: "connected",
          externalPropertyId: "provider-846",
          messagingAppInstalled: false,
        },
        capabilityModes: Object.fromEntries(
          Object.keys(pmsWebChannexSnapshot.capabilityModes).map((key) => [key, "mutating"]),
        ),
      },
    }),
  );
  const alert = {
    id: "84600000-0000-4000-8000-000000000001",
    eventType: "booking_unmapped_room",
    impact: { bookingId: "reservation-846" },
    firstOccurredAt: "2026-09-06T00:00:00Z",
    lastOccurredAt: "2026-09-07T00:00:00Z",
    acknowledgedAt: null as string | null,
    resolvedAt: null as string | null,
    recoveryRound: 0,
    occurrences: 2,
    recovery: [] as Array<{
      status: string;
      attemptsMade: number;
      maxAttempts: number;
      retryAfter: null;
    }>,
  };
  await page.unroute(`${routeBase}/alerts`);
  await page.route(`${routeBase}/alerts`, (route) => route.fulfill({ json: [alert] }));
  let retries = 0;
  await page.route(`${routeBase}/alerts/${alert.id}/acknowledge`, (route) => {
    alert.acknowledgedAt = new Date().toISOString();
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(`${routeBase}/alerts/${alert.id}/recover`, (route) => {
    retries++;
    expect(route.request().postDataJSON()).toEqual({ round: 0 });
    alert.recoveryRound = 1;
    alert.recovery = [{ status: "pending", attemptsMade: 0, maxAttempts: 5, retryAfter: null }];
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/channel-manager");
  const section = page.getByRole("region", { name: "Channel alerts" });
  await expect(section.getByText("A booking needs a room mapping")).toBeVisible();
  await expect(section.getByText("Unknown", { exact: true }).first()).toBeVisible();
  await expect(section.getByRole("button", { name: "Retry recovery" })).toBeDisabled();
  await section.getByRole("button", { name: "Mark seen" }).click();
  await expect(section.getByRole("button", { name: "Seen — still open" })).toBeDisabled();
  await section.getByRole("checkbox").check();
  await section.getByRole("button", { name: "Retry recovery" }).click();
  await expect(section.getByText("Recovery is running; this alert remains open.")).toBeVisible();
  expect(retries).toBe(1);
  alert.recovery = [{ status: "succeeded", attemptsMade: 1, maxAttempts: 5, retryAfter: null }];
  await section.getByRole("button", { name: "Refresh alerts" }).click();
  await expect(section.getByText("Recovery verified", { exact: true })).toHaveCount(0);
  alert.resolvedAt = new Date().toISOString();
  await section.getByRole("button", { name: "Refresh alerts" }).click();
  await expect(section.getByText("Recovery verified", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("channel-alert-recovery.png"),
    fullPage: true,
  });
  await healthy();
});

test("reads diagnostic evidence for alerts without triggering recovery", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const events = ["non_acked_booking", "rate_error", "disconnected_channel"];
  const alerts = events.map((eventType, index) => ({
    id: `diagnostic-${index}`,
    eventType,
    impact: {},
    firstOccurredAt: "2026-09-17T10:00:00Z",
    lastOccurredAt: "2026-09-17T10:00:00Z",
    acknowledgedAt: null,
    resolvedAt: null,
    recoveryRound: 1,
    occurrences: 1,
    recovery: [],
  }));
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().includes("/channex/") && request.method() !== "GET") writes++;
  });
  await page.route(`${routeBase}/alerts`, (route) => route.fulfill({ json: alerts }));
  let fail = false;
  await page.route(`${routeBase}/alerts/*/diagnostics`, (route) => {
    if (fail) return route.fulfill({ status: 503, json: { code: "diagnostics_unavailable" } });
    const alertId = route.request().url().split("/").at(-2);
    return route.fulfill({
      json: {
        alertId,
        recoveryRound: 1,
        observedAt: "2026-09-17T10:05:00Z",
        newerOccurrence: false,
        linkedJobCount: 1,
        latestReceipt: {
          receiptId: "receipt-reference",
          occurredAt: "2026-09-17T10:00:00Z",
          receivedAt: "2026-09-17T10:00:01Z",
        },
        recovery: [
          {
            jobId: "job-reference",
            operation: "sync_ari",
            status: "dead_lettered",
            updatedAt: "2026-09-17T10:01:00Z",
            attemptsMade: 1,
            failure: "A required room or rate mapping is missing.",
          },
        ],
      },
    });
  });
  await page.goto("/channel-manager");
  const cards = page.getByRole("region", { name: "Channel alerts" }).locator("article");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) {
    await card.getByText("Diagnostic details", { exact: true }).click();
    await expect(card.getByText("A required room or rate mapping is missing.")).toBeVisible();
    await expect(card.getByText(/These do not confirm current delivery/)).toBeVisible();
    await expect(card.getByText(/Receipt reference: receipt-reference/)).toBeVisible();
  }
  fail = true;
  await cards.first().getByRole("button", { name: "Refresh evidence" }).click();
  await expect(cards.first().getByText(/Diagnostic details are unavailable/)).toBeVisible();
  await expect(cards.first().getByText("A required room or rate mapping is missing.")).toHaveCount(
    0,
  );
  await expect(page.getByText("Recovery verified", { exact: true })).toHaveCount(0);
  expect(writes).toBe(0);
});
