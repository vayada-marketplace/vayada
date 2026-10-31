import type { PoolClient } from "pg";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("./pricingAcceptanceAmendments.js", () => ({ loadCurrentPricingAcceptance: vi.fn() }));
import { loadCurrentPricingAcceptance } from "./pricingAcceptanceAmendments.js";
import { quotePricingStayDateChange, type PricingStayRepricer } from "./pricingStayDateChange.js";

const booking = {
  guestBookingId: "booking",
  propertyId: "property",
  checkIn: "2026-11-10",
  checkOut: "2026-11-12",
  roomCount: 1,
  currency: "EUR",
  totalAmount: "200.00",
};
const accepted = (addons: unknown[]) => ({
  editRevision: 1,
  acceptance: { propertyTimeZone: "Europe/Berlin" },
  quote: {
    acceptanceMode: "instant",
    stay: {
      checkIn: "2026-11-10",
      checkOut: "2026-11-12",
      currency: "EUR",
      rooms: [{}],
      addons,
      promoCode: null,
    },
    evidence: { lines: [] },
  },
});

/** Answers the reads before the PMS adoption check; that check refuses, so nothing is priced. */
function client(extrasRequests: number) {
  const queries: string[] = [];
  const query = async (text: string) => {
    queries.push(text);
    if (text.includes("edit_revision")) return { rows: [{ editRevision: 1 }] };
    if (text.includes("booking_change_requests"))
      return { rows: Array.from({ length: extrasRequests }, () => ({ "?column?": 1 })) };
    return { rows: [{ rooms: 0 }] };
  };
  return { client: { query } as unknown as PoolClient, queries };
}
const reprice: PricingStayRepricer = async () => {
  throw new Error("not priced");
};
const change = (db: PoolClient) =>
  quotePricingStayDateChange(db, {
    booking,
    request: { checkIn: "2026-11-20", checkOut: "2026-11-22" },
    today: "2026-11-01",
    reprice,
  });

beforeEach(() => vi.mocked(loadCurrentPricingAcceptance).mockReset());

// VAY-2428: a date change keeps a stay's extras on the days they were booked for by refusing it.
it("refuses a stay with booked extras before reading anything else", async () => {
  vi.mocked(loadCurrentPricingAcceptance).mockResolvedValue(
    accepted([{ id: "breakfast", quantity: 2, dates: ["2026-11-10", "2026-11-11"] }]) as never,
  );
  const { client: db, queries } = client(0);
  await expect(change(db)).rejects.toMatchObject({
    code: "unsupported_edit",
    message: "Bookings with add-ons can't change dates here yet.",
  });
  expect(queries.some((text) => text.includes("booking_change_requests"))).toBe(false);
});

it("refuses a stay with extras the guest asked for, waiting or accepted, and goes on without", async () => {
  vi.mocked(loadCurrentPricingAcceptance).mockResolvedValue(accepted([]) as never);
  const asked = client(1);
  await expect(change(asked.client)).rejects.toMatchObject({
    code: "unsupported_edit",
    message: "Bookings with requested extras can't change dates here yet.",
  });
  expect(asked.queries.find((text) => text.includes("booking_change_requests"))).toMatch(
    /request_type='addon_change' AND status IN \('pending','accepted'\)/,
  );
  // Without one, the change goes on to the next check (here: the PMS hasn't adopted the stay).
  await expect(change(client(0).client)).rejects.toMatchObject({
    message: "This booking is still being set up in the PMS. Try again in a few minutes.",
  });
});
