import { expect, it, vi } from "vitest";
import { readBookingAffiliateContextForQuote } from "./bookingAffiliateContextForQuote.js";

const contextId = "33333333-3333-4333-8333-333333333333";

it("rejects malformed handles without querying Booking storage", async () => {
  const query = vi.fn();
  expect(
    await readBookingAffiliateContextForQuote({ query } as never, "hotel", "not-a-uuid"),
  ).toBeNull();
  expect(query).not.toHaveBeenCalled();
});

it("returns a live admitted context only for the quote's canonical hotel", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rowCount: 1 });
  expect(await readBookingAffiliateContextForQuote({ query } as never, "hotel", contextId)).toBe(
    contextId,
  );
  expect(query).toHaveBeenCalledWith(expect.stringContaining("context.synthetic=FALSE"), [
    contextId,
    "hotel",
  ]);
  expect(query.mock.calls[0][0]).toContain("booking.affiliate_click_admissions");
  expect(query.mock.calls[0][0]).toContain("interval '90 days'");
  expect(query.mock.calls[0][0]).toContain("hotel.purpose='canonical'");
  query.mockResolvedValueOnce({ rowCount: 0 });
  expect(
    await readBookingAffiliateContextForQuote({ query } as never, "other-hotel", contextId),
  ).toBeNull();
});
