import { parseBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { admitAffiliateArrivalInTransaction } from "./bookingAffiliateClickAdmission.js";
import {
  admitAffiliateArrivalForCurrentHost,
  readBookingAffiliateArrivalHost,
} from "./bookingAffiliateArrivalHost.js";
import { lockAffiliateDestinationSafety } from "./bookingAffiliateDestinationSafetyLock.js";

vi.mock("@vayada/domain-distribution/booking-publication", () => ({
  parseBookingPublicContent: vi.fn(),
}));
vi.mock("./bookingAffiliateClickAdmission.js", () => ({
  admitAffiliateArrivalInTransaction: vi.fn(),
}));
vi.mock("./bookingAffiliateDestinationSafetyLock.js", () => ({
  lockAffiliateDestinationSafety: vi.fn(),
}));

const propertyId = "aa29a9d9-9ca4-4931-9ef5-4d41e9a9cc41";

function profile(input: { host: string; slug?: string; custom?: boolean }) {
  return {
    profile: {
      hotel: {
        propertyId,
        slug: input.slug ?? "hotel-alpenrose",
        bookingBaseUrl: `https://${input.host}`,
        customDomainUrl: input.custom ? `https://${input.host}` : null,
        trust: { bookabilityStatus: "bookable" },
      },
      freshness: { status: "fresh" },
    },
  };
}

function database(rows: { propertyId: string; publicContent: unknown }[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe("affiliate arrival host resolution", () => {
  it("resolves a current canonical Vayada host from the active Booking publication", async () => {
    const db = database([{ propertyId, publicContent: { id: "publication" } }]);
    vi.mocked(parseBookingPublicContent).mockReturnValue(
      profile({ host: "hotel-alpenrose.next-booking.vayada.com" }) as never,
    );

    await expect(
      readBookingAffiliateArrivalHost(db, "HOTEL-ALPENROSE.next-booking.vayada.com"),
    ).resolves.toEqual({
      host: "hotel-alpenrose.next-booking.vayada.com",
      propertyId,
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("property_slugs"), [
      "hotel-alpenrose.next-booking.vayada.com",
      "hotel-alpenrose",
    ]);
  });

  it("requires current domain ownership and a matching canonical custom host", async () => {
    const db = database([{ propertyId, publicContent: { id: "publication" } }]);
    vi.mocked(parseBookingPublicContent).mockReturnValue(
      profile({ host: "book.alpenrose.example", custom: true }) as never,
    );

    await expect(readBookingAffiliateArrivalHost(db, "book.alpenrose.example")).resolves.toEqual({
      host: "book.alpenrose.example",
      propertyId,
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("property_domains"), [
      "book.alpenrose.example",
      null,
    ]);
  });

  it("fails closed before querying for malformed hosts and on ambiguous ownership", async () => {
    for (const host of ["bad%2Fhost", "bad..example", "hotel.example:8443", undefined]) {
      const db = database([]);
      await expect(readBookingAffiliateArrivalHost(db, host)).resolves.toBeUndefined();
      expect(db.query).not.toHaveBeenCalled();
    }
    const ambiguous = database([
      { propertyId, publicContent: {} },
      { propertyId: "bb29a9d9-9ca4-4931-9ef5-4d41e9a9cc41", publicContent: {} },
    ]);
    await expect(
      readBookingAffiliateArrivalHost(ambiguous, "book.alpenrose.example"),
    ).resolves.toBeUndefined();
  });

  it("rejects stale or mismatched published host identity", async () => {
    const db = database([{ propertyId, publicContent: { id: "publication" } }]);
    const invalid = profile({ host: "other.example", custom: true });
    vi.mocked(parseBookingPublicContent).mockReturnValue(invalid as never);
    await expect(
      readBookingAffiliateArrivalHost(db, "book.alpenrose.example"),
    ).resolves.toBeUndefined();

    invalid.profile.hotel.bookingBaseUrl = "https://book.alpenrose.example";
    invalid.profile.freshness.status = "stale";
    await expect(
      readBookingAffiliateArrivalHost(db, "book.alpenrose.example"),
    ).resolves.toBeUndefined();
  });

  it("rechecks the host under its locks and admits on the same transaction", async () => {
    const row = { propertyId, publicContent: { id: "publication" } };
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("FROM distribution.active_public_booking_revision"))
          return { rows: [row] };
        if (text.includes("FROM hotel_catalog.properties"))
          return { rows: [{ id: propertyId }], rowCount: 1 };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [row] }),
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as pg.Pool;
    vi.mocked(parseBookingPublicContent).mockReturnValue(
      profile({ host: "hotel-alpenrose.next-booking.vayada.com" }) as never,
    );
    vi.mocked(admitAffiliateArrivalInTransaction).mockResolvedValue({
      status: "admitted",
      contextId: "dd29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
      contextCreated: true,
      clickId: "ee29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
      historyPosition: "1",
      replayed: false,
    });

    await expect(
      admitAffiliateArrivalForCurrentHost(pool, {
        host: "hotel-alpenrose.next-booking.vayada.com",
        referenceToken: "vc_abcdefghijklmnopqrstuv",
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(lockAffiliateDestinationSafety).toHaveBeenCalledWith(client, propertyId);
    expect(admitAffiliateArrivalInTransaction).toHaveBeenCalledWith(client, {
      propertyId,
      referenceToken: "vc_abcdefghijklmnopqrstuv",
      contextId: undefined,
    });
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
