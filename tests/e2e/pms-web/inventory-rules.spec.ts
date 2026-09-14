import { expect, test } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  pmsWebChannexSnapshot,
} from "../support/pmsWebMocks";
import type { ChannexInventoryRule } from "../../../packages/domain-pms-channex/src/inventoryRules";

test("edits all inventory rule types, exposes failures, retries and removes (mock API)", async ({
  page,
}, testInfo) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex`;
  const roomId = "123e4567-e89b-42d3-a456-426614174000";
  const channelId = "223e4567-e89b-42d3-a456-426614174000";
  const secondChannel = "323e4567-e89b-42d3-a456-426614174000";
  let rules: ChannexInventoryRule[] = [];
  let fail = false;
  let operation: Record<string, unknown> | null = null;
  let submissions = 0;
  await page.unroute(base);
  await page.route(base, (route) =>
    route.fulfill({
      json: {
        ...pmsWebChannexSnapshot,
        connection: {
          status: "connected",
          externalPropertyId: "provider-property",
          messagingAppInstalled: false,
        },
        mappings: {
          roomTypes: [
            {
              mappingId: roomId,
              roomTypeId: roomId,
              roomTypeName: "Synthetic suite",
              externalRoomTypeId: "provider-room",
              status: "active",
            },
          ],
          ratePlans: [],
        },
        channels: [
          {
            externalChannelId: channelId,
            key: "booking_com",
            title: "Booking.com",
            application: "BookingCom",
            isActive: true,
          },
          {
            externalChannelId: secondChannel,
            key: "airbnb",
            title: "Airbnb",
            application: "Airbnb",
            isActive: true,
          },
        ],
        capabilityModes: { ...pmsWebChannexSnapshot.capabilityModes, ariSync: "mutating" },
        inventoryRules: { rules, operation },
        activeOperation: operation?.status === "queued" ? operation : null,
      },
    }),
  );
  await page.route(`${base}/inventory-rules`, async (route) => {
    const body = route.request().postDataJSON();
    rules = body.rules;
    submissions++;
    operation = {
      contractVersion: "pms-channex-management.v1",
      operationId: roomId,
      propertyId: PMS_WEB_PROPERTY_ID,
      operationType: "update_inventory_rules",
      status: "queued",
      commandId: body.commandId,
      idempotencyKey: body.idempotencyKey,
      acceptedAt: "2026-09-07T00:00:00Z",
      attemptsMade: 1,
      maxAttempts: 5,
      retryAfter: null,
      lastError: null,
    };
    await route.fulfill({ status: 202, json: operation });
  });
  await page.route(`${base}/operations/${roomId}`, async (route) => {
    operation = {
      ...operation,
      status: fail ? "dead_lettered" : "succeeded",
      lastError: fail ? { code: "provider_rejected", message: "Synthetic provider failure" } : null,
    };
    await route.fulfill({ json: operation });
  });
  await page.goto("/channel-manager");
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Channel inventory rules" }) });
  await panel.getByRole("button", { name: "Add rule" }).click();
  await panel.getByLabel("Rooms", { exact: true }).fill("2");
  await panel.getByLabel("From", { exact: true }).fill("2026-10-01");
  await panel.getByLabel("Through (inclusive)").fill("2026-10-07");
  await panel.getByLabel("Synthetic suite", { exact: true }).check();
  await panel.getByLabel("Airbnb", { exact: true }).uncheck();
  await expect(panel.getByText(/Excluded connected channels: Airbnb/)).toBeVisible();
  await panel.getByRole("button", { name: "Save and synchronize" }).click();
  await expect.poll(() => submissions).toBe(1);
  await expect(panel.getByText("Availability offset: 2 rooms", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByLabel("Rule type").selectOption("max_availability");
  await panel.getByLabel("Rooms", { exact: true }).fill("3");
  await expect(
    panel.getByText(/This is an availability ceiling, not a cumulative sales quota/),
  ).toBeVisible();
  fail = true;
  await panel.getByRole("button", { name: "Save and synchronize" }).click();
  await expect(panel.getByText("Synthetic provider failure")).toBeVisible();
  await page.reload();
  await expect(panel.getByText("Synthetic provider failure")).toBeVisible();
  await expect(panel.getByText(/not confirmed until synchronization succeeds/)).toBeVisible();
  fail = false;
  await panel.getByRole("button", { name: "Retry synchronization" }).click();
  await expect(panel.getByText(/update inventory rules: succeeded/i)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inventory-rules.png"), fullPage: true });
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByLabel("Rule type").selectOption("close_out");
  await expect(panel.getByLabel("Rooms", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Save and synchronize" }).click();
  await expect(panel.getByText("Channel close-out", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(panel.getByText("No requested inventory rules.")).toBeVisible();
  expect(rules).toEqual([]);
  expect(submissions).toBe(5);
});

test("blocks inventory edits when its pending operation differs from the page operation", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex`;
  await page.unroute(base);
  await page.route(base, (route) =>
    route.fulfill({
      json: {
        ...pmsWebChannexSnapshot,
        activeOperation: null,
        inventoryRules: {
          rules: [
            {
              id: "rule",
              type: "close_out",
              value: null,
              channelIds: ["channel"],
              roomTypeIds: ["room"],
              startDate: "2026-10-01",
              endDate: "2026-10-02",
              days: ["thu", "fri"],
            },
          ],
          operation: {
            operationId: "pending-inventory",
            operationType: "update_inventory_rules",
            status: "queued",
            attemptsMade: 0,
            maxAttempts: 5,
            lastError: null,
          },
        },
      },
    }),
  );
  await page.goto("/channel-manager");
  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Channel inventory rules" }) });
  await expect(panel.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
});
