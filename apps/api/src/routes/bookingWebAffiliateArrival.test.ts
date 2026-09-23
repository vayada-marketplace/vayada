import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { admitAffiliateArrival } from "../domains/bookingAffiliateClickAdmission.js";
import type { PublicHotelProfileRepository } from "./aiHotels.js";
import { admitBookingWebAffiliateArrival } from "./bookingWebPublic.js";

vi.mock("../domains/bookingAffiliateClickAdmission.js", () => ({
  admitAffiliateArrival: vi.fn(),
}));

const base = PUBLIC_BOOKABILITY_FIXTURES[0]!.profile;
const pool = {} as pg.Pool;
const referenceToken = "vc_abcdefghijklmnopqrstuv";

function repository(profile: PublicBookabilityProfileProjection): PublicHotelProfileRepository {
  return {
    findProfileBySlug: vi.fn().mockResolvedValue(profile),
    findProfileByCustomDomain: vi.fn().mockResolvedValue(profile),
  };
}

describe("native affiliate arrival host boundary", () => {
  it("admits a reference only for the resolved final host's property", async () => {
    const profile = {
      ...base,
      hotel: {
        ...base.hotel,
        propertyId: "aa29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
        bookingBaseUrl: "https://hotel-alpenrose.next-booking.vayada.com",
      },
    };
    const repo = repository(profile);
    vi.mocked(admitAffiliateArrival).mockResolvedValue({
      status: "admitted",
      contextId: "dd29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
      contextCreated: true,
      clickId: "ee29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
      historyPosition: "1",
      replayed: false,
    });
    const result = await admitBookingWebAffiliateArrival(pool, repo, {
      host: "HOTEL-ALPENROSE.next-booking.vayada.com",
      referenceToken,
    });
    expect(result.status).toBe("admitted");
    expect(repo.findProfileBySlug).toHaveBeenCalledWith("hotel-alpenrose");
    expect(admitAffiliateArrival).toHaveBeenCalledWith(pool, {
      propertyId: profile.hotel.propertyId,
      referenceToken,
      contextId: undefined,
    });
  });

  it("rejects a fallback host when a different custom domain is canonical", async () => {
    vi.mocked(admitAffiliateArrival).mockClear();
    const profile = {
      ...base,
      hotel: { ...base.hotel, bookingBaseUrl: "https://book.alpenrose.example" },
    };
    expect(
      await admitBookingWebAffiliateArrival(pool, repository(profile), {
        host: "hotel-alpenrose.next-booking.vayada.com",
        referenceToken,
      }),
    ).toEqual({ status: "unavailable" });
    expect(admitAffiliateArrival).not.toHaveBeenCalled();
  });

  it("uses a verified custom-domain lookup and never accepts an unknown host", async () => {
    vi.mocked(admitAffiliateArrival).mockClear();
    const profile = {
      ...base,
      hotel: { ...base.hotel, bookingBaseUrl: "https://book.alpenrose.example" },
    };
    const repo = repository(profile);
    await admitBookingWebAffiliateArrival(pool, repo, {
      host: "book.alpenrose.example",
      referenceToken,
    });
    expect(repo.findProfileByCustomDomain).toHaveBeenCalledWith("book.alpenrose.example");
    expect(admitAffiliateArrival).toHaveBeenCalledOnce();
    vi.mocked(admitAffiliateArrival).mockClear();
    expect(
      await admitBookingWebAffiliateArrival(pool, repo, {
        host: "attacker.example",
        referenceToken,
      }),
    ).toEqual({ status: "unavailable" });
    expect(admitAffiliateArrival).not.toHaveBeenCalled();
  });

  it("does not admit malformed hosts or a non-HTTPS canonical destination", async () => {
    vi.mocked(admitAffiliateArrival).mockClear();
    const repo = repository(base);
    for (const host of [
      "bad%2Fhost",
      "bad..example",
      "hotel-alpenrose.booking.localhost@evil.com",
      "hotel-alpenrose.booking.localhost:8443",
    ]) {
      expect(await admitBookingWebAffiliateArrival(pool, repo, { host, referenceToken })).toEqual({
        status: "unavailable",
      });
    }
    expect(repo.findProfileBySlug).not.toHaveBeenCalled();
    const insecure = {
      ...base,
      hotel: { ...base.hotel, bookingBaseUrl: "http://hotel-alpenrose.booking.localhost" },
    };
    expect(
      await admitBookingWebAffiliateArrival(pool, repository(insecure), {
        host: "hotel-alpenrose.booking.localhost",
        referenceToken,
      }),
    ).toEqual({ status: "unavailable" });
    expect(admitAffiliateArrival).not.toHaveBeenCalled();
  });

  it("does not admit a revoked custom domain", async () => {
    vi.mocked(admitAffiliateArrival).mockClear();
    const repo: PublicHotelProfileRepository = {
      findProfileBySlug: vi.fn().mockResolvedValue(null),
      findProfileByCustomDomain: vi.fn().mockResolvedValue(null),
    };
    expect(
      await admitBookingWebAffiliateArrival(pool, repo, {
        host: "book.alpenrose.example",
        referenceToken,
      }),
    ).toEqual({ status: "unavailable" });
    expect(admitAffiliateArrival).not.toHaveBeenCalled();
  });
});
