import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), resolvePropertyId: vi.fn() }));
vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, put: mocks.put },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));
vi.mock("../api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

import { guestRulesRefusal, guestRulesService } from "./guestRules";

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

  it("answers null while the property has none, and reads a named property as is", async () => {
    mocks.get.mockResolvedValue({ current: null });
    await expect(guestRulesService.load(undefined, "property-2")).resolves.toBeNull();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/booking/properties/property-2/guest-rules",
      expect.anything(),
    );
    expect(mocks.resolvePropertyId).not.toHaveBeenCalled();
  });

  it("saves confirmed choices over the expected revision, once per idempotency key", async () => {
    const saved = "7e2d4b63-6c6f-4d4a-8b62-2a4a9e2c3d5f";
    mocks.put.mockResolvedValue({ revision: saved, replayed: false });
    await expect(
      guestRulesService.save(PROPERTY, REVISION, choices as never, "arrival-times:1"),
    ).resolves.toBe(saved);
    expect(mocks.put).toHaveBeenCalledWith(
      `/api/booking/properties/${PROPERTY}/guest-rules`,
      { expectedRevision: REVISION, confirmed: true, choices },
      { cache: "no-store", headers: { "Idempotency-Key": "arrival-times:1" } },
    );
    mocks.put.mockResolvedValue({});
    await expect(
      guestRulesService.save(PROPERTY, null, choices as never, "arrival-times:2"),
    ).rejects.toThrow("could not be confirmed");
  });

  it("reads each refusal the API answers with a code", () => {
    const refusal = (code: string) =>
      Object.assign(new Error("API Error: 409"), { data: { code } });
    expect(guestRulesRefusal(refusal("guest_choices_stale"))).toBe("guest_choices_stale");
    expect(guestRulesRefusal(refusal("guest_choices_denied"))).toBe("guest_choices_denied");
    expect(guestRulesRefusal(refusal("something_else"))).toBeNull();
    expect(guestRulesRefusal(new TypeError("Failed to fetch"))).toBeNull();
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
