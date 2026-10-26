import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkIn: "2026-10-13",
  windows: [] as { method: string; kind: string; amount: number; unit: string }[],
}));
vi.mock("./publicPricingAuthority.js", () => ({
  lockPublicPricingAuthority: vi.fn(async () => ({
    propertyId: "61000000-0000-4000-8000-000000000001",
    organizationId: "61000000-0000-4000-8000-000000000002",
  })),
}));
vi.mock("./currentPricingQuote.js", () => ({
  lockCurrentPricingQuote: vi.fn(async () => ({
    quote: {
      quoteId: "61000000-0000-4000-8000-000000000003",
      stay: { propertyId: "61000000-0000-4000-8000-000000000001", checkIn: mocks.checkIn },
      evidence: { expiresAt: "2026-10-12T10:05:00.000Z" },
    },
  })),
}));
vi.mock("./pricingManualPayment.js", () => ({
  lockPricingManualPaymentTerms: vi.fn(async (_client: unknown, _id: string, method: string) => ({
    method,
    paymentWindowHours: method === "bank_transfer" ? 48 : 24,
    paypalEmail: method === "paypal" ? "pay@hotel.example" : null,
  })),
}));

import { createCurrentPricingQuoteStore } from "./currentPricingQuoteStore.js";

const selection = {
  version: "public-pricing-selection.v1",
  checkIn: "2026-10-13",
  checkOut: "2026-10-14",
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

function store() {
  const inserted: unknown[] = [];
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push(text);
      if (text.includes("FROM booking.pricing_quotes")) return { rows: [] };
      if (text.includes("FROM finance.payment_method_booking_windows"))
        return { rows: mocks.windows };
      // 12:00 in Rome on 2026-10-12; check-in from 15:00.
      if (text.includes('AS "checkInTime"'))
        return {
          rows: [
            { timeZone: "Europe/Rome", checkInTime: "15:00", now: new Date("2026-10-12T10:00Z") },
          ],
        };
      if (text.includes("INSERT INTO booking.pricing_quotes")) {
        inserted.push(values);
        return { rows: [{ id: "q" }], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
  return { inserted, queries, issue: createCurrentPricingQuoteStore(pool, 300).issue };
}

describe("current pricing quote store: bank-transfer and PayPal lead time (VAY-2145)", () => {
  it("refuses a bank-transfer quote whose check-in is closer than its deadline", async () => {
    mocks.checkIn = "2026-10-13";
    const s = store();
    await expect(
      s.issue("hotel", { requestId: "quote-1", selection, paymentMethod: "bank_transfer" }),
    ).rejects.toMatchObject({ code: "denied", reason: "manual_payment_too_soon" });
    expect(s.inserted).toEqual([]);
  });

  it("issues it once check-in is far enough away, and leaves other methods alone", async () => {
    mocks.checkIn = "2026-10-17";
    const bank = store();
    await expect(
      bank.issue("hotel", { requestId: "quote-2", selection, paymentMethod: "bank_transfer" }),
    ).resolves.toMatchObject({ replayed: false });
    expect(bank.inserted).toHaveLength(1);
    // A stay tomorrow can still be paid at the property.
    mocks.checkIn = "2026-10-13";
    const atProperty = store();
    await expect(
      atProperty.issue("hotel", {
        requestId: "quote-3",
        selection,
        paymentMethod: "pay_at_property",
      }),
    ).resolves.toMatchObject({ replayed: false });
    expect(atProperty.queries.some((text) => text.includes('AS "checkInTime"'))).toBe(false);
  });
});

describe("current pricing quote store: booking windows per payment method (VAY-2348)", () => {
  it("quotes pay at the property only within its window, counted to the check-in time", async () => {
    mocks.windows = [{ method: "pay_at_property", kind: "within", amount: 48, unit: "hours" }];
    // Check-in on 2026-10-14 at 15:00 Rome is 51 hours away: outside the window.
    mocks.checkIn = "2026-10-14";
    const far = store();
    await expect(
      far.issue("hotel", { requestId: "quote-4", selection, paymentMethod: "pay_at_property" }),
    ).rejects.toMatchObject({ code: "denied", reason: "payment_method_window" });
    expect(far.inserted).toEqual([]);
    // Tomorrow at 15:00 is 27 hours away.
    mocks.checkIn = "2026-10-13";
    const near = store();
    await expect(
      near.issue("hotel", { requestId: "quote-5", selection, paymentMethod: "pay_at_property" }),
    ).resolves.toMatchObject({ replayed: false });
    // Card has no window here.
    mocks.checkIn = "2026-10-14";
    const card = store();
    await expect(
      card.issue("hotel", { requestId: "quote-6", selection, paymentMethod: "card" }),
    ).resolves.toMatchObject({ replayed: false });
    expect(card.queries.some((text) => text.includes('AS "checkInTime"'))).toBe(false);
    mocks.windows = [];
  });
});
