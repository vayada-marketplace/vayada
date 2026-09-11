import { describe, expect, it, vi } from "vitest";
import { createBookingGuestPolicyClient } from "./bookingGuestPolicyClient";
const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  propertyId: "20000000-0000-4000-8000-000000000002",
};
const choices = {
  defaultGuestLanguage: "en",
  childrenEnabled: false,
  adultAgeThreshold: null,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
  checkInUntil: "23:00",
} as const;
const sourceFingerprint = `sha256:${"1".repeat(64)}` as const;
const bundleHash = `sha256:${"2".repeat(64)}` as const;
function fixture() {
  const bundle = {
    ...scope,
    contractVersion: "booking-guest-policy.v1",
    choices,
    sourceFingerprint,
    bundleHash,
    pricingCurrency: "EUR",
    propertyTimeZone: "Europe/Berlin",
    rates: [
      {
        roomTypeId: "room1",
        flexible: {
          freeCancellationDeadlineDays: 2,
          cutoff: { localTime: "18:00", timeZone: "Europe/Berlin" },
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
        nonRefundable: null,
        additionalGuest: null,
      },
    ],
  };
  const current = { ...scope, contractVersion: "booking-guest-policy.v1", revision: 1, bundle };
  const aggregate = {
    ...scope,
    contractVersion: "booking-guest-policy.v1",
    supportedLanguages: ["en", "de", "fr", "es", "id", "nl"],
    current,
    draft: null,
  };
  const http = {
    get: vi.fn().mockResolvedValue(aggregate),
    post: vi.fn().mockResolvedValue({ outcome: "ready", bundle }),
    put: vi.fn().mockResolvedValue({ outcome: "created", revision: current }),
  };
  return { http, client: createBookingGuestPolicyClient(http), aggregate, current, bundle };
}
const request = {
  expectedRevision: 0,
  expectedSourceFingerprint: sourceFingerprint,
  choices,
  confirmPolicyBundle: true,
};
describe("guest policy browser boundary", () => {
  it("preserves saved arrival bounds", async () => {
    const h = fixture();
    expect((await h.client.load(scope)).choices).toEqual(choices);
  });
  it("keeps first-entry required answers empty", async () => {
    const h = fixture();
    const draft = {
      ...choices,
      defaultGuestLanguage: null,
      childrenEnabled: null,
      checkInTime: null,
      checkOutTime: null,
    };
    h.http.get.mockResolvedValue({ ...h.aggregate, current: null, draft });
    expect(await h.client.load(scope)).toEqual({ revision: 0, choices: draft });
  });
  it("rejects cross-property evidence on every operation", async () => {
    const h = fixture();
    const other = { ...scope, propertyId: "another" };
    await expect(h.client.load(other)).rejects.toThrow();
    await expect(h.client.preview(other, choices)).rejects.toThrow();
    await expect(h.client.save(other, request, h.bundle)).rejects.toThrow();
  });
  it("rejects malformed or mismatched cancellation preview", async () => {
    const h = fixture();
    h.http.post.mockResolvedValue({
      outcome: "ready",
      bundle: { ...h.bundle, choices: { ...choices, phoneRequired: false } },
    });
    await expect(h.client.preview(scope, choices)).rejects.toThrow();
    h.bundle.rates[0].flexible.cutoff.localTime = "25:00";
    h.http.post.mockResolvedValue({ outcome: "ready", bundle: h.bundle });
    await expect(h.client.preview(scope, choices)).rejects.toThrow();
  });
  it("keeps dependency blockers blocked", async () => {
    const h = fixture();
    const value = {
      outcome: "blocked",
      ...scope,
      sourceFingerprint,
      blockers: [{ code: "pricing_source_missing" }],
    };
    h.http.post.mockResolvedValue(value);
    expect(await h.client.preview(scope, choices)).toEqual(value);
  });
  it("reuses the idempotency key after an uncertain response", async () => {
    const h = fixture();
    h.http.put.mockRejectedValueOnce(new Error("network"));
    await expect(h.client.save(scope, request, h.bundle)).rejects.toThrow("network");
    await h.client.save(scope, request, h.bundle);
    expect(h.http.put.mock.calls[0]).toEqual(h.http.put.mock.calls[1]);
  });
  it("requires confirmation and checks the saved revision and reviewed bundle", async () => {
    const h = fixture();
    await expect(
      h.client.save(scope, { ...request, confirmPolicyBundle: false }, h.bundle),
    ).rejects.toThrow();
    expect(h.http.put).not.toHaveBeenCalled();
    await expect(
      h.client.save(scope, request, { ...h.bundle, bundleHash: sourceFingerprint }),
    ).rejects.toThrow();
    h.current.revision = 3;
    await expect(h.client.save(scope, request, h.bundle)).rejects.toThrow();
  });
  it("rejects changed answers before committing an unreviewed policy", async () => {
    const h = fixture();
    await expect(
      h.client.save(
        scope,
        { ...request, choices: { ...choices, checkInUntil: "22:00" } },
        h.bundle,
      ),
    ).rejects.toThrow();
    expect(h.http.put).not.toHaveBeenCalled();
  });
  it("propagates denied access and never treats it as a new draft", async () => {
    const h = fixture();
    h.http.get.mockRejectedValue(new Error("Forbidden"));
    await expect(h.client.load(scope)).rejects.toThrow("Forbidden");
  });
});
