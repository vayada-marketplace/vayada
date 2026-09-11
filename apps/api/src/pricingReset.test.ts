import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import { describe, expect, it, vi } from "vitest";
import { createPgPmsRecurringPricingCommandRepository } from "./domains/pmsRecurringPricingCommandRepository.js";
import { createPgChannelDatePrices } from "./domains/pmsChannelDatePrices.js";
import { calculateManualBookingPreview } from "./routes/pmsManualBookingPreviewCalculation.js";
import {
  createTargetCheckoutQuote,
  loadTargetCheckoutOffer,
  createTargetBookingWebCalendarRepository,
} from "./routes/bookingWebPublic.js";
import { createTargetPublicHotelQuoteRepository } from "./routes/aiHotelQuotes.js";
import { quoteTargetRoomSelection } from "./routes/bookingWebMixedQuote.js";

const unavailable = { code: "PRICING_UNAVAILABLE", statusCode: 503 };
describe("pricing reset", () => {
  it("rejects every old recurring write without opening a database connection", async () => {
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
      await expect(method(undefined as never)).rejects.toMatchObject(unavailable);
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
  it("does not quote old offers, calendars, manual stays or mixed room selections", async () => {
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
    ).rejects.toMatchObject(unavailable);
    await expect(quotes.findQuoteBySlug("hotel", {})).rejects.toMatchObject(unavailable);
    await expect(
      createTargetCheckoutQuote(pool, undefined as never, undefined as never, new Date()),
    ).rejects.toMatchObject(unavailable);
    await expect(loadTargetCheckoutOffer(pool, undefined as never)).rejects.toMatchObject(
      unavailable,
    );
    await expect(quoteTargetRoomSelection(pool, undefined as never)).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      calculateManualBookingPreview(undefined as never, undefined as never, undefined as never),
    ).rejects.toMatchObject(unavailable);
    expect(query).not.toHaveBeenCalled();
    await calendar.close?.();
    await quotes.close?.();
  });
});

it("cannot seed rates through room creation or duplication", async () => {
  const pool = { connect: vi.fn(), end: vi.fn() };
  const repository = createTargetPmsOperationsCommandRepository({
    connectionString: "unused",
    pool,
    readRepository: undefined as never,
  });
  await expect(repository.createRoomType(undefined as never)).rejects.toMatchObject(unavailable);
  await expect(repository.duplicateRoomType(undefined as never)).rejects.toMatchObject(unavailable);
  expect(pool.connect).not.toHaveBeenCalled();
  await repository.close?.();
});
