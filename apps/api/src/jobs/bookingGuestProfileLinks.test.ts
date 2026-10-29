import { describe, expect, it, vi } from "vitest";

import {
  profileValuesFromBooking,
  startGuestProfileLinkWorker,
  type GuestProfileLinkStore,
  type GuestProfileSource,
} from "./bookingGuestProfileLinks.js";

const profile = { email: "desk@example.test", phone: "+4915100000000", countryCode: "DE" };
const direct: GuestProfileSource = {
  guestRole: "booker",
  email: "new@example.test",
  phone: "+4917600000000",
  countryCode: "AT",
  sourceSystem: "pms",
  bookingChannel: "direct",
  contactVisible: true,
  applied: false,
  contactApplied: false,
};

describe("profileValuesFromBooking", () => {
  it("lets a direct booking overwrite the first time, but never clear a value", () => {
    expect(profileValuesFromBooking(profile, direct)).toEqual({
      email: "new@example.test",
      phone: "+4917600000000",
      countryCode: "AT",
    });
    expect(
      profileValuesFromBooking(profile, { ...direct, email: "  ", phone: null, countryCode: null }),
    ).toEqual(profile);
  });

  it("only fills gaps from a booking applied before, so an old booking can't undo newer details", () => {
    const again = { ...direct, applied: true, contactApplied: true };
    expect(profileValuesFromBooking(profile, again)).toEqual(profile);
    expect(
      profileValuesFromBooking({ email: null, phone: null, countryCode: null }, again),
    ).toEqual({ email: "new@example.test", phone: "+4917600000000", countryCode: "AT" });
    // Contact that waited for acceptance arrives as new.
    expect(profileValuesFromBooking(profile, { ...again, contactApplied: false })).toEqual({
      ...profile,
      email: "new@example.test",
      phone: "+4917600000000",
    });
  });

  it("lets a channel booking only fill empty fields", () => {
    const channel = {
      ...direct,
      email: "x1y2@guest.booking.com",
      bookingChannel: "booking_com",
    };
    expect(profileValuesFromBooking(profile, channel)).toEqual(profile);
    expect(
      profileValuesFromBooking({ email: null, phone: null, countryCode: null }, channel),
    ).toEqual({ email: "x1y2@guest.booking.com", phone: "+4917600000000", countryCode: "AT" });
  });

  it("keeps email and phone back while the property may not see them", () => {
    expect(profileValuesFromBooking(null, { ...direct, contactVisible: false })).toEqual({
      email: null,
      phone: null,
      countryCode: "AT",
    });
  });

  it("takes nationality from PMS bookings and additional guests, not the booking engine's booker", () => {
    const bookingEngine = { ...direct, sourceSystem: "booking" };
    expect(profileValuesFromBooking(profile, bookingEngine).countryCode).toBe("DE");
    expect(
      profileValuesFromBooking(profile, { ...bookingEngine, guestRole: "additional_guest" })
        .countryCode,
    ).toBe("AT");
    expect(profileValuesFromBooking(null, { ...direct, countryCode: "ZZ" }).countryCode).toBeNull();
  });
});

describe("startGuestProfileLinkWorker", () => {
  const logger = { info: vi.fn(), error: vi.fn() };

  it("drains full batches and stops on a short one", async () => {
    const batches = [
      { linked: 2, failed: 0 },
      { linked: 1, failed: 1 },
      { linked: 1, failed: 0 },
    ];
    const store: GuestProfileLinkStore = {
      linkBatch: vi.fn(async () => batches.shift() ?? { linked: 0, failed: 0 }),
      close: vi.fn(async () => undefined),
    };
    const worker = startGuestProfileLinkWorker({ store, enabled: false, batchSize: 2, logger });
    await worker.runNow();
    expect(store.linkBatch).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { linked: 4, failed: 1 },
      "Linked booking guests to guest profiles",
    );
    await worker.close();
    expect(store.close).toHaveBeenCalled();
  });

  it("stops when a full batch only fails, so failing rows can't loop", async () => {
    const store: GuestProfileLinkStore = {
      linkBatch: vi.fn(async () => ({ linked: 0, failed: 2 })),
      close: vi.fn(async () => undefined),
    };
    const worker = startGuestProfileLinkWorker({ store, enabled: false, batchSize: 2, logger });
    await worker.runNow();
    expect(store.linkBatch).toHaveBeenCalledTimes(1);
    await worker.close();
  });

  it("logs a failed run instead of throwing", async () => {
    const error = new Error("database down");
    const store: GuestProfileLinkStore = {
      linkBatch: vi.fn(async () => {
        throw error;
      }),
      close: vi.fn(async () => undefined),
    };
    const worker = startGuestProfileLinkWorker({ store, enabled: false, logger });
    await worker.runNow();
    expect(logger.error).toHaveBeenCalledWith({ err: error }, "Guest profile linking failed");
    await worker.close();
  });
});
