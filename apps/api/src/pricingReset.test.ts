import { describe, expect, it, vi } from "vitest";
import {
  createTargetCheckoutQuote,
  loadTargetCheckoutOffer,
  loadTargetCheckoutQuoteSnapshot,
} from "./routes/bookingWebPublic.js";
import { quoteTargetRoomSelection } from "./routes/bookingWebMixedQuote.js";

const unavailable = { code: "PRICING_UNAVAILABLE", statusCode: 503 };
// The old public flow is gone for good (VAY-1543 C.2; its routes were removed in VAY-2387).
// Checkout snapshots answer 410 PRICING_RETIRED so callers learn to use the room-and-price flow.
const retired = { code: "PRICING_RETIRED", statusCode: 410 };
describe("pricing reset", () => {
  it("retires old checkout snapshots; change-request quoting stays unavailable", async () => {
    const query = vi.fn();
    const pool = { query, end: vi.fn() };
    await expect(
      createTargetCheckoutQuote(pool, undefined as never, undefined as never, new Date()),
    ).rejects.toMatchObject(retired);
    await expect(
      loadTargetCheckoutQuoteSnapshot(pool, "property", undefined as never, new Date()),
    ).rejects.toMatchObject(retired);
    await expect(loadTargetCheckoutOffer(pool, undefined as never)).rejects.toMatchObject(
      unavailable,
    );
    await expect(quoteTargetRoomSelection(pool, undefined as never)).rejects.toMatchObject(
      unavailable,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
