import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import { describe, expect, it, vi } from "vitest";
import { createPgPmsRecurringPricingCommandRepository } from "./domains/pmsRecurringPricingCommandRepository.js";
import { createPgChannelDatePrices } from "./domains/pmsChannelDatePrices.js";
import {
  createTargetCheckoutQuote,
  loadTargetCheckoutOffer,
  loadTargetCheckoutQuoteSnapshot,
  createTargetBookingWebCalendarRepository,
} from "./routes/bookingWebPublic.js";
import { createTargetPublicHotelQuoteRepository } from "./routes/aiHotelQuotes.js";
import { quoteTargetRoomSelection } from "./routes/bookingWebMixedQuote.js";

const unavailable = { code: "PRICING_UNAVAILABLE", statusCode: 503 };
// The old public flow is gone for good (VAY-1543 C.2): offers, calendar and checkout
// snapshots answer 410 PRICING_RETIRED so callers learn to use the room-and-price flow.
const retired = { code: "PRICING_RETIRED", statusCode: 410 };
describe("pricing reset", () => {
  it("retires every old recurring write without opening a database connection", async () => {
    const pool = { connect: vi.fn(), end: vi.fn() };
    const port = createPgPmsRecurringPricingCommandRepository({ connectionString: "unused", pool });
    for (const method of [
      port.upsertRecurringSeason,
      port.upsertWeekendSurcharge,
      port.upsertAdditionalGuestPricing,
      port.upsertNonRefundablePricing,
      port.disableRecurringPricingSource,
      port.materializeRecurringPricing,
    ]) {
      await expect(method(undefined as never)).rejects.toMatchObject({
        code: "PRICING_RETIRED",
        statusCode: 503,
      });
    }
    await port.close();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
  });
  it("rejects date price reads and writes without a database", async () => {
    const port = createPgChannelDatePrices("unused");
    await expect(port.get(undefined as never)).rejects.toMatchObject(unavailable);
    await expect(port.put(undefined as never, undefined as never)).rejects.toMatchObject(
      unavailable,
    );
    await port.close();
  });
  it("retires old offers, calendars and checkout snapshots; change-request quoting stays unavailable", async () => {
    const query = vi.fn();
    const pool = { query, end: vi.fn() };
    const calendar = createTargetBookingWebCalendarRepository({ connectionString: "unused", pool });
    const quotes = createTargetPublicHotelQuoteRepository({
      connectionString: "unused",
      pool,
      profileRepository: undefined as never,
    });
    await expect(
      calendar.findCalendarByHotel(undefined as never, undefined as never),
    ).rejects.toMatchObject(retired);
    await expect(quotes.findQuoteBySlug("hotel", {})).rejects.toMatchObject(retired);
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
    await calendar.close?.();
    await quotes.close?.();
  });
});

// Duplication is back without rate seeding (VAY-1422 slice A.3); creation still embeds legacy
// rates in its command, so it stays unavailable until the room form drops them.
it("cannot seed rates through room creation", async () => {
  const pool = { connect: vi.fn(), end: vi.fn() };
  const repository = createTargetPmsOperationsCommandRepository({
    connectionString: "unused",
    pool,
    readRepository: undefined as never,
  });
  await expect(repository.createRoomType(undefined as never)).rejects.toMatchObject(unavailable);
  expect(pool.connect).not.toHaveBeenCalled();
  await repository.close?.();
});
