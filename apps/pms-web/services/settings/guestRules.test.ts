import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), resolvePropertyId: vi.fn() }));
vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));
vi.mock("../api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

import { guestRulesService } from "./guestRules";

const PROPERTY = "f6853000-0000-4000-8000-000000000001";
const REVISION = "6d1c3a52-5b5e-4c3f-9a51-1f3f8d1b2c4e";
const choices = {
  defaultGuestLanguage: "en",
  childrenEnabled: true,
  adultAgeThreshold: 12,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};

describe("guest rules service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue(PROPERTY);
  });

  it("reads the selected property's guest rules, the ones the booking page shows", async () => {
    mocks.get.mockResolvedValue({ current: { revision: REVISION, choices } });
    const signal = new AbortController().signal;
    await expect(guestRulesService.load(signal)).resolves.toEqual({ revision: REVISION, choices });
    expect(mocks.get).toHaveBeenCalledWith(`/api/booking/properties/${PROPERTY}/guest-rules`, {
      cache: "no-store",
      signal,
    });
  });

  it("answers null while the property has none", async () => {
    mocks.get.mockResolvedValue({ current: null });
    await expect(guestRulesService.load()).resolves.toBeNull();
  });

  it("refuses a malformed answer instead of showing made-up times", async () => {
    for (const answer of [
      undefined,
      {},
      { current: { revision: REVISION } },
      { current: { revision: REVISION, choices: { ...choices, checkOutTime: "noon" } } },
      { current: { choices } },
    ]) {
      mocks.get.mockResolvedValueOnce(answer);
      await expect(guestRulesService.load()).rejects.toThrow("Guest rules could not be loaded.");
    }
  });
});
