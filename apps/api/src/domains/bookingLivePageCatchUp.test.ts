import { beforeEach, describe, expect, it, vi } from "vitest";

const { canPublishBookingPage } = vi.hoisted(() => ({ canPublishBookingPage: vi.fn() }));
vi.mock("./bookingPublicationCommandRepository.js", () => ({ canPublishBookingPage }));

import { catchUpLiveBookingPages } from "./bookingLivePageCatchUp.js";
import { BookingPublicationNotReadyError } from "./bookingPublicationProductionRuntime.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const owner = "44444444-4444-4444-8444-444444444444";
const page = (n: number, overrides: Record<string, unknown> = {}) => ({
  propertyId: `22222222-2222-4222-8222-00000000000${n}`,
  organizationId,
  actorUserId: owner,
  sourceManifestHash: `sha256:${String(n).repeat(64)}`,
  ...overrides,
});
const notReady = new BookingPublicationNotReadyError({
  outcome: "evaluated",
  product: "booking",
  status: "blocked",
  groups: [
    {
      groupId: "booking.calendar",
      steps: [
        {
          entities: [
            {
              blockers: [
                { code: "operating_calendar_source_stale", message: "Save your calendar again." },
              ],
            },
            {
              blockers: [
                { code: "operating_calendar_source_stale", message: "Save your calendar again." },
              ],
            },
          ],
        },
      ],
    },
  ],
} as unknown as ConstructorParameters<typeof BookingPublicationNotReadyError>[0]);

describe("live booking page catch-up (VAY-2472)", () => {
  beforeEach(() => {
    canPublishBookingPage.mockReset();
  });

  it("republishes only pages behind their sources, as the user who made them live", async () => {
    const pages = [page(1), page(2), page(3), page(4), page(5, { organizationId: null }), page(6)];
    const query = vi.fn().mockResolvedValue({ rows: pages, rowCount: pages.length });
    // Page 6's activator lost access: skipped, never run as someone else.
    canPublishBookingPage.mockImplementation(
      async (_pool: unknown, scope: { propertyId: string }) =>
        scope.propertyId !== pages[5]!.propertyId,
    );
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ operationId: "op-1", status: "succeeded" })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(new Error("Booking publication refresh did not complete."));
    const now = new Date("2026-11-04T19:00:00.000Z");

    const result = await catchUpLiveBookingPages(
      { pool: { query }, refresh, now: () => now },
      { runId: "run-1", limit: 50, propertyIds: pages.map(({ propertyId }) => propertyId) },
    );

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![1]).toEqual([50, pages.map(({ propertyId }) => propertyId)]);
    expect(result).toEqual({
      livePages: 6,
      unchanged: 1,
      refreshed: [pages[0]!.propertyId],
      blocked: [
        {
          propertyId: pages[2]!.propertyId,
          codes: ["booking.calendar:operating_calendar_source_stale"],
        },
      ],
      noAccess: [pages[4]!.propertyId, pages[5]!.propertyId],
      failed: [
        {
          propertyId: pages[3]!.propertyId,
          detail: "Booking publication refresh did not complete.",
        },
      ],
    });
    expect(canPublishBookingPage).toHaveBeenCalledTimes(5);
    expect(canPublishBookingPage).toHaveBeenCalledWith(
      { query },
      { organizationId, propertyId: pages[0]!.propertyId, actorUserId: owner },
      now,
    );
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenNthCalledWith(1, {
      organizationId,
      propertyId: pages[0]!.propertyId,
      actorUserId: owner,
      idempotencyKey: `booking.live_page_catch_up:run-1:${pages[0]!.propertyId}`,
      audit: { requestId: "run-1", source: "booking.live_page_catch_up" },
      onlyIfLive: true,
      skipIfSourceManifestHash: pages[0]!.sourceManifestHash,
    });
  });

  it("checks every live page when no hotels are named", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const refresh = vi.fn();

    await expect(
      catchUpLiveBookingPages({ pool: { query }, refresh }, { runId: "run-2", limit: 50 }),
    ).resolves.toEqual({
      livePages: 0,
      unchanged: 0,
      refreshed: [],
      blocked: [],
      noAccess: [],
      failed: [],
    });
    expect(query.mock.calls[0]![1]).toEqual([50, null]);
    expect(refresh).not.toHaveBeenCalled();
  });
});
