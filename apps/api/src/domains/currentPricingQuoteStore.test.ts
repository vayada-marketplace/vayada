import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { createCurrentPricingQuoteStore } from "./currentPricingQuoteStore.js";

const selection = {
  version: "public-pricing-selection.v1",
  checkIn: "2026-10-01",
  checkOut: "2026-10-02",
  currency: "EUR",
  rooms: [
    {
      selectionId: "one",
      publicOfferKey: "offer",
      guests: { adults: 1, childAgesAtCheckIn: [] },
    },
  ],
  addons: [],
  promoCode: null,
};

describe("current pricing quote store", () => {
  it("destroys an active quote connection when its caller disconnects", async () => {
    let rejectActive: ((error: Error) => void) | undefined;
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (queries.length === 1) return { rows: [], rowCount: null };
        return new Promise<never>((_resolve, reject) => {
          rejectActive = reject;
        });
      }),
      release: vi.fn((error?: Error) => error && rejectActive?.(error)),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const cancellation = new AbortController();
    const pending = createCurrentPricingQuoteStore(pool, 300).issue(
      "synthetic-hotel",
      {
        requestId: "quote-1",
        selection,
        paymentMethod: "pay_at_property",
      },
      cancellation.signal,
    );
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(2));
    cancellation.abort();
    await expect(pending).rejects.toThrow("Pricing command aborted");
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    expect(queries).not.toContain("COMMIT");
  });
});
