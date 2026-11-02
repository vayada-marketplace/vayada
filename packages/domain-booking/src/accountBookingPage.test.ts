import { describe, expect, it } from "vitest";

import {
  defaultAccountBookingPageSettings,
  parseAccountBookingPageSettings,
  parseAccountBookingPageSlug,
  parseAccountBookingPageUpdate,
  readAccountBookingPageSettings,
  suggestAccountBookingPageSlug,
  type AccountBookingPageSettings,
} from "./accountBookingPage.js";

// VAY-2456: the agency booking page's settings (VAY-2450 sections C1–C7).
const propertyA = "20000000-0000-4000-8000-00000000000a";
const propertyB = "20000000-0000-4000-8000-00000000000b";

function custom(): AccountBookingPageSettings {
  return {
    page: { title: "The Travel Ubud", description: "13 villas, guest houses and resorts in Ubud" },
    header: {
      topLeft: "name",
      designPropertyId: propertyA,
      gallery: true,
      contact: true,
      language: false,
      currency: true,
      contactEmail: "stay@travelubud.example",
      contactWhatsapp: "+6281234567890",
    },
    layout: { allowed: ["list", "map"], default: "map" },
    results: { defaultSort: "recommended", lowestPriceBadge: false, showFullStays: true },
    filters: {
      propertyType: true,
      area: true,
      price: false,
      privatePool: true,
      breakfast: false,
      freeCancellation: true,
      bedrooms: false,
    },
    stayPage: { nearby: false, map: true },
  };
}

function update(overrides: Record<string, unknown> = {}) {
  return {
    revision: 3,
    slug: "thetravelubud",
    live: true,
    settings: custom(),
    propertyIds: [propertyA, propertyB],
    ...overrides,
  };
}

describe("agency booking page settings", () => {
  it("starts from the mockup's defaults with the account name as title and Contact off", () => {
    const defaults = defaultAccountBookingPageSettings("  The Travel Ubud ");
    expect(defaults).toEqual({
      page: { title: "The Travel Ubud", description: "" },
      header: {
        topLeft: "name",
        designPropertyId: null,
        gallery: true,
        contact: false,
        language: true,
        currency: true,
        contactEmail: null,
        contactWhatsapp: null,
      },
      layout: { allowed: ["list", "split", "map"], default: "list" },
      results: { defaultSort: "price_low", lowestPriceBadge: true, showFullStays: true },
      filters: {
        propertyType: true,
        area: false,
        price: true,
        privatePool: true,
        breakfast: true,
        freeCancellation: false,
        bedrooms: false,
      },
      stayPage: { nearby: true, map: true },
    });
    expect(parseAccountBookingPageSettings(defaults)).toEqual(defaults);
  });

  it("accepts a full save and keeps every field", () => {
    expect(parseAccountBookingPageUpdate(update())).toEqual(update());
    expect(parseAccountBookingPageUpdate(update({ revision: 0, live: false }))).toMatchObject({
      revision: 0,
      live: false,
    });
  });

  it("trims text, lowercases property ids and puts layouts in the fixed order", () => {
    const settings = custom();
    settings.page.title = "  The Travel Ubud  ";
    settings.header.designPropertyId = propertyA.toUpperCase();
    settings.layout = { allowed: ["map", "split", "list"], default: "split" };
    const parsed = parseAccountBookingPageUpdate(
      update({ settings, propertyIds: [propertyB.toUpperCase()] }),
    );
    expect(parsed?.settings.page.title).toBe("The Travel Ubud");
    expect(parsed?.settings.header.designPropertyId).toBe(propertyA);
    expect(parsed?.settings.layout).toEqual({
      allowed: ["list", "split", "map"],
      default: "split",
    });
    expect(parsed?.propertyIds).toEqual([propertyB]);
  });

  it("refuses unknown or missing keys at every level", () => {
    const extraTop = { ...update(), extra: 1 };
    const missingTop: Record<string, unknown> = update();
    delete missingTop["live"];
    expect(parseAccountBookingPageUpdate(extraTop)).toBeNull();
    expect(parseAccountBookingPageUpdate(missingTop)).toBeNull();
    for (const section of ["page", "header", "layout", "results", "filters", "stayPage"] as const) {
      const extra = custom() as unknown as Record<string, Record<string, unknown>>;
      extra[section] = { ...extra[section], unexpected: true };
      expect(parseAccountBookingPageSettings(extra), `extra key in ${section}`).toBeNull();
      const missing = custom() as unknown as Record<string, Record<string, unknown>>;
      const rest = { ...missing[section]! };
      delete rest[Object.keys(rest)[0]!];
      missing[section] = rest;
      expect(parseAccountBookingPageSettings(missing), `missing key in ${section}`).toBeNull();
    }
  });

  it("refuses wrong values", () => {
    const invalid: Array<[string, (settings: AccountBookingPageSettings) => void]> = [
      ["empty title", (s) => (s.page.title = "   ")],
      ["long title", (s) => (s.page.title = "x".repeat(101))],
      ["title with a line break", (s) => (s.page.title = "The Travel\nUbud")],
      ["long description", (s) => (s.page.description = "x".repeat(301))],
      ["unknown top-left", (s) => ((s.header as { topLeft: string }).topLeft = "banner")],
      ["design property not an id", (s) => (s.header.designPropertyId = "escape-villa")],
      ["switch not a boolean", (s) => ((s.header as { gallery: unknown }).gallery = "yes")],
      ["email without domain", (s) => (s.header.contactEmail = "stay@")],
      ["WhatsApp without +", (s) => (s.header.contactWhatsapp = "6281234567890")],
      ["WhatsApp with spaces", (s) => (s.header.contactWhatsapp = "+62 812 3456 7890")],
      [
        "Contact on without a way to reach the agency",
        (s) => {
          s.header.contactEmail = null;
          s.header.contactWhatsapp = null;
        },
      ],
      ["layouts without List", (s) => (s.layout = { allowed: ["split", "map"], default: "map" })],
      ["unknown layout", (s) => ((s.layout.allowed as string[]) = ["list", "grid"])],
      ["layout twice", (s) => (s.layout.allowed = ["list", "list"])],
      ["default not allowed", (s) => (s.layout = { allowed: ["list"], default: "map" })],
      ["unknown sort", (s) => ((s.results as { defaultSort: string }).defaultSort = "rating")],
      ["filter not a boolean", (s) => ((s.filters as { area: unknown }).area = 1)],
      ["stay page not a boolean", (s) => ((s.stayPage as { map: unknown }).map = null)],
    ];
    for (const [name, change] of invalid) {
      const settings = custom();
      change(settings);
      expect(parseAccountBookingPageSettings(settings), name).toBeNull();
    }
  });

  it("refuses bad revisions, switches and property lists", () => {
    for (const overrides of [
      { revision: -1 },
      { revision: 1.5 },
      { revision: "3" },
      { live: "true" },
      { propertyIds: [propertyA, propertyA] },
      { propertyIds: [propertyA, propertyA.toUpperCase()] },
      { propertyIds: ["escape-villa"] },
      { propertyIds: propertyA },
      {
        propertyIds: Array.from(
          { length: 201 },
          (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      },
    ])
      expect(
        parseAccountBookingPageUpdate(update(overrides)),
        JSON.stringify(overrides),
      ).toBeNull();
  });

  it("takes host-label slugs only", () => {
    for (const slug of ["thetravelubud", "the-travel-ubud", "ubud13", "a"])
      expect(parseAccountBookingPageSlug(slug)).toBe(slug);
    for (const slug of [
      "",
      "The-Travel-Ubud",
      "-ubud",
      "ubud-",
      "the--travel",
      "travel_ubud",
      "travel.ubud",
      "x".repeat(64),
      "www",
      "booking",
      42,
    ])
      expect(parseAccountBookingPageSlug(slug), String(slug)).toBeNull();
  });

  it("suggests an address from the account name", () => {
    expect(suggestAccountBookingPageSlug("The Travel Ubud")).toBe("the-travel-ubud");
    expect(suggestAccountBookingPageSlug("Café Señora & Co.")).toBe("cafe-senora-co");
    expect(suggestAccountBookingPageSlug("Booking")).toBe("stays");
    expect(suggestAccountBookingPageSlug("!!!")).toBe("stays");
    const long = suggestAccountBookingPageSlug(`${"villa ".repeat(20)}end`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(parseAccountBookingPageSlug(long)).toBe(long);
  });

  it("reads a stored value leniently onto the defaults", () => {
    const defaults = defaultAccountBookingPageSettings("The Travel Ubud");
    expect(readAccountBookingPageSettings(null, defaults)).toEqual(defaults);
    expect(readAccountBookingPageSettings(custom(), defaults)).toEqual(custom());

    const stored = custom() as unknown as Record<string, Record<string, unknown>>;
    stored["page"]!["title"] = "";
    stored["header"]!["designPropertyId"] = "not-an-id";
    stored["header"]!["somethingNew"] = true;
    stored["layout"] = { allowed: ["list", "split"], default: "map" };
    delete stored["filters"]!["bedrooms"];
    stored["stayPage"] = "broken" as unknown as Record<string, unknown>;
    const read = readAccountBookingPageSettings(stored, defaults);
    expect(read.page.title).toBe("The Travel Ubud");
    expect(read.header.designPropertyId).toBeNull();
    expect(read.header).not.toHaveProperty("somethingNew");
    expect(read.layout).toEqual({ allowed: ["list", "split"], default: "list" });
    expect(read.filters.bedrooms).toBe(false);
    expect(read.filters.area).toBe(true);
    expect(read.stayPage).toEqual(defaults.stayPage);
    expect(parseAccountBookingPageSettings(read)).toEqual(read);
  });

  it("turns Contact off when a stored value has no way to reach the agency", () => {
    const defaults = defaultAccountBookingPageSettings("The Travel Ubud");
    const stored = custom();
    stored.header.contactEmail = null;
    stored.header.contactWhatsapp = null;
    expect(readAccountBookingPageSettings(stored, defaults).header.contact).toBe(false);
  });

  it("makes a valid title from any account name", () => {
    for (const name of ["x".repeat(140), "The\nTravel\tUbud", "   ", "\u0007"]) {
      const defaults = defaultAccountBookingPageSettings(name);
      expect(parseAccountBookingPageSettings(defaults), JSON.stringify(name)).toEqual(defaults);
    }
    expect(defaultAccountBookingPageSettings("The\nTravel Ubud").page.title).toBe(
      "The Travel Ubud",
    );
    expect(defaultAccountBookingPageSettings("   ").page.title).toBe("Our stays");
  });

  it("never hands out the defaults' own arrays", () => {
    const first = defaultAccountBookingPageSettings("A");
    first.layout.allowed.pop();
    expect(defaultAccountBookingPageSettings("A").layout.allowed).toEqual(["list", "split", "map"]);
  });
});
