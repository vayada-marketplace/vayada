import { defaultAccountBookingPageSettings } from "@vayada/domain-booking/account-booking-page";
import { describe, expect, it, vi } from "vitest";
import {
  createAccountBookingPageClient,
  parseAccountBookingPageSummary,
} from "./accountBookingPageClient";

// VAY-2457: Booking Admin reads and saves the agency booking page (next-api, VAY-2456).
const defaults = defaultAccountBookingPageSettings("The Travel Ubud");
const escape = "20000000-0000-4000-8000-00000000000a";
const summary = {
  saved: true,
  page: {
    slug: "thetravelubud",
    live: true,
    revision: 4,
    settings: defaults,
    propertyIds: [escape],
  },
  defaults,
  properties: [
    {
      propertyId: escape,
      name: "The Escape Villa Ubud",
      propertyType: "villa",
      area: "Ubud",
      photoUrl: "https://cdn.example/escape.jpg",
      units: 2,
      ready: true,
      missing: [],
      included: true,
    },
  ],
  canSave: true,
};

describe("account booking page client", () => {
  it("takes the summary next-api sends", () => {
    expect(parseAccountBookingPageSummary(summary)).toEqual(summary);
  });

  it("drops photos the browser shouldn't load and counts no units below one", () => {
    const parsed = parseAccountBookingPageSummary({
      ...summary,
      properties: [{ ...summary.properties[0], photoUrl: "http://cdn.example/a.jpg", units: -1 }],
    });
    expect(parsed?.properties[0]).toMatchObject({ photoUrl: null, units: 0 });
  });

  it("refuses a summary its own rules wouldn't save", () => {
    for (const broken of [
      null,
      { ...summary, saved: "yes" },
      { ...summary, page: { ...summary.page, slug: "The Travel Ubud" } },
      {
        ...summary,
        page: {
          ...summary.page,
          settings: { ...defaults, layout: { allowed: ["map"], default: "map" } },
        },
      },
      { ...summary, defaults: {} },
      { ...summary, properties: [{ ...summary.properties[0], missing: ["photos"] }] },
      { ...summary, properties: "none" },
    ])
      expect(parseAccountBookingPageSummary(broken), JSON.stringify(broken)).toBeNull();
  });

  it("loads without caching and saves the update as given", async () => {
    const http = {
      get: vi.fn(async () => summary),
      put: vi.fn(async () => ({ ...summary, page: { ...summary.page, revision: 5 } })),
    };
    const client = createAccountBookingPageClient(http as never);
    expect(await client.load()).toEqual(summary);
    expect(http.get).toHaveBeenCalledWith("/api/booking/account-booking-page", {
      signal: undefined,
      cache: "no-store",
    });
    const update = {
      revision: 4,
      slug: "thetravelubud",
      live: true,
      settings: defaults,
      propertyIds: [escape],
    };
    expect((await client.save(update)).page.revision).toBe(5);
    expect(http.put).toHaveBeenCalledWith("/api/booking/account-booking-page", update);
  });

  it("fails loudly on an answer it can't read", async () => {
    const client = createAccountBookingPageClient({
      get: vi.fn(async () => ({})),
      put: vi.fn(async () => ({})),
    } as never);
    await expect(client.load()).rejects.toThrow("could not be loaded");
    await expect(
      client.save({ revision: 0, slug: "x", live: false, settings: defaults, propertyIds: [] }),
    ).rejects.toThrow("could not be confirmed");
  });
});
