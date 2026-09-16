import { expect, it, vi } from "vitest";
import { createTargetPlatformAdminDashboardRepository } from "./bookingCompatible.js";

it.each(["recorded", "unverified"] as const)(
  "preserves admin booking records with %s money",
  async (amountStatus) => {
    const query = vi
      .fn()
      .mockResolvedValue({
        rows: [
          {
            id: "booking",
            totalAmount: "155.00",
            amountStatus,
            requestedAt: "2026-09-01T00:00:00Z",
            respondedAt: null,
          },
        ],
      });
    const repository = createTargetPlatformAdminDashboardRepository({
      connectionString: "postgres://test",
      pool: { query, end: vi.fn() },
    });
    const rows = await repository.listBookings({ limit: 10, offset: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "booking",
      amountStatus,
      totalAmount: amountStatus === "unverified" ? null : 155,
    });
    expect(query.mock.calls[0]![0]).toContain("airbnbMoneyStatus");
  },
);
