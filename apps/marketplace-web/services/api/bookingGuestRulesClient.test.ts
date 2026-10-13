import { expect, it, vi } from "vitest";
import { createBookingGuestRulesClient } from "./bookingGuestRulesClient";
vi.mock("./targetClient", () => ({ targetApiClient: {} }));
const id = "11111111-1111-4111-8111-111111111111";
const choices = {
  defaultGuestLanguage: "en" as const,
  childrenEnabled: false,
  adultAgeThreshold: null,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};
it("loads missing or saved rules and sends explicit confirmation with no client authority", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({ current: null })
    .mockResolvedValueOnce({ current: { revision: id, choices } });
  const put = vi.fn().mockResolvedValue({ revision: id, replayed: false });
  const client = createBookingGuestRulesClient({ get, put });
  expect(await client.load(id)).toBeNull();
  expect(await client.load(id)).toEqual({ revision: id, choices });
  expect(await client.save(id, null, choices, "retry-key")).toEqual({ revision: id, choices });
  expect(put).toHaveBeenCalledWith(
    `/api/booking/properties/${id}/guest-rules`,
    { expectedRevision: null, confirmed: true, choices },
    { headers: { "Idempotency-Key": "retry-key" } },
  );
});
it("rejects malformed responses and preserves API conflicts", async () => {
  const get = vi.fn().mockResolvedValue({ current: { revision: id, choices: {} } });
  const conflict = new Error("guest_choices_stale");
  const put = vi
    .fn()
    .mockRejectedValueOnce(conflict)
    .mockResolvedValue({ revision: "bad", replayed: false });
  const client = createBookingGuestRulesClient({ get, put });
  await expect(client.load(id)).rejects.toThrow();
  await expect(client.save(id, id, choices, "same-key")).rejects.toBe(conflict);
  await expect(client.save(id, id, choices, "same-key")).rejects.toThrow(
    "save could not be confirmed",
  );
});
it("loads and saves the guest terms without other fields", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({ termsText: null })
    .mockResolvedValueOnce({ termsText: "Our terms." })
    .mockResolvedValueOnce({ termsText: 3 });
  const put = vi
    .fn()
    .mockResolvedValueOnce({ termsText: "Our terms." })
    .mockResolvedValueOnce({ termsText: "Our terms.", propertyId: id });
  const client = createBookingGuestRulesClient({ get, put });
  expect(await client.loadTerms(id)).toBeNull();
  expect(await client.loadTerms(id)).toBe("Our terms.");
  await expect(client.loadTerms(id)).rejects.toThrow("could not be loaded");
  expect(await client.saveTerms(id, "Our terms.", null)).toBe("Our terms.");
  expect(put).toHaveBeenCalledWith(`/api/booking/properties/${id}/guest-terms`, {
    termsText: "Our terms.",
    expectedTermsText: null,
  });
  await expect(client.saveTerms(id, "Our terms.", null)).rejects.toThrow("could not be confirmed");
});
