import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));
vi.mock("../api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: async () => "f6853000-0000-4000-8000-000000000001",
}));

import { guestStayTimesService } from "./guestStayTimes";

describe("guest stay times service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the selected property's check-in and check-out times from the PMS", async () => {
    mocks.get.mockResolvedValue({
      propertyId: "f6853000-0000-4000-8000-000000000001",
      times: { checkInTime: "14:00", checkOutTime: "10:30" },
    });
    await expect(guestStayTimesService.load()).resolves.toEqual({
      checkInTime: "14:00",
      checkOutTime: "10:30",
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/f6853000-0000-4000-8000-000000000001/guest-stay-times",
      { cache: "no-store" },
    );
  });

  it("answers null while the property has no guest rules", async () => {
    mocks.get.mockResolvedValue({ propertyId: "x", times: null });
    await expect(guestStayTimesService.load()).resolves.toBeNull();
  });

  it("refuses a malformed answer instead of showing made-up times", async () => {
    for (const answer of [
      undefined,
      {},
      { times: { checkInTime: "15:00" } },
      { times: { checkInTime: "noon", checkOutTime: "11:00" } },
    ]) {
      mocks.get.mockResolvedValueOnce(answer);
      await expect(guestStayTimesService.load()).rejects.toThrow(
        "Check-in and check-out times could not be loaded.",
      );
    }
  });
});
