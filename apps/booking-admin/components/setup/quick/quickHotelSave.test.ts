import { describe, expect, it, vi } from "vitest";

import { quickHotelCurrency } from "./quickHotelCurrency";
import type { QuickHotelDraft } from "./quickHotelDraft";
import {
  quickHotelProfileRequest,
  saveQuickHotel,
  type QuickHotelSaveDeps,
} from "./quickHotelSave";

const DRAFT: QuickHotelDraft = {
  displayName: " Hotel Alpenrose ",
  propertyType: "hotel",
  streetAddress: "Sendlinger Straße 12",
  postalCode: "80331",
  city: "Munich",
  countryCode: "de",
  latitude: 48.135,
  longitude: 11.567,
  timezone: "Europe/Berlin",
  contactEmail: " reception@alpenrose.example ",
  phone: "+49 89 1234567",
  currency: "",
};
const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";

function deps(): QuickHotelSaveDeps & {
  setup: { [K in keyof QuickHotelSaveDeps["setup"]]: ReturnType<typeof vi.fn> };
  saveCurrency: ReturnType<typeof vi.fn>;
} {
  return {
    setup: {
      updateTracks: vi.fn(async () => ({})),
      createPropertyProfile: vi.fn(async () => ({ propertyId: PROPERTY, profileRevision: 1 })),
      uploadPropertyLogo: vi.fn(async () => "media-1"),
      assignPropertyLogo: vi.fn(async () => ({})),
    },
    saveCurrency: vi.fn(async () => undefined),
  } as never;
}

const input = (overrides: Partial<Parameters<typeof saveQuickHotel>[0]> = {}) => ({
  draft: { ...DRAFT, countryCode: "DE" },
  currency: quickHotelCurrency("DE", "")!,
  language: "de",
  logo: null,
  organization: { selectedTracks: ["hotel_operations" as const], trackRevision: 1 },
  draftKey: "draft-1",
  ...overrides,
});

describe("saveQuickHotel (VAY-2247 'Your hotel')", () => {
  it("creates the hotel with public city and country, reception contacts and its first launch settings", async () => {
    const d = deps();
    expect(await saveQuickHotel(input(), d)).toEqual({ propertyId: PROPERTY, logoSaved: false });
    expect(d.setup.updateTracks).not.toHaveBeenCalled();
    expect(d.setup.createPropertyProfile).toHaveBeenCalledWith(
      quickHotelProfileRequest(
        { ...DRAFT, countryCode: "DE" },
        quickHotelCurrency("DE", "")!,
        "de",
      ),
      "quick-setup:create:draft-1",
    );
    expect(d.saveCurrency).not.toHaveBeenCalled();
    expect(d.setup.uploadPropertyLogo).not.toHaveBeenCalled();
  });

  it("chooses the hotel-operations track first when the group has none", async () => {
    const d = deps();
    await saveQuickHotel(input({ organization: { selectedTracks: [], trackRevision: 0 } }), d);
    expect(d.setup.updateTracks).toHaveBeenCalledWith(
      { selectedTracks: ["hotel_operations"], expectedRevision: 0 },
      "quick-setup:tracks:draft-1",
    );
    expect(d.setup.updateTracks.mock.invocationCallOrder[0]).toBeLessThan(
      d.setup.createPropertyProfile.mock.invocationCallOrder[0]!,
    );
  });

  it("uploads and assigns the logo, and keeps the hotel when the logo fails", async () => {
    const logo = { name: "logo.png" } as File;
    const d = deps();
    expect(await saveQuickHotel(input({ logo }), d)).toMatchObject({ logoSaved: true });
    expect(d.setup.assignPropertyLogo).toHaveBeenCalledWith(
      PROPERTY,
      { expectedProfileRevision: 1, mediaObjectId: "media-1", altText: null },
      "quick-setup:logo-assign:draft-1",
    );
    const failing = deps();
    failing.setup.uploadPropertyLogo.mockRejectedValueOnce(new Error("too big"));
    expect(await saveQuickHotel(input({ logo }), failing)).toEqual({
      propertyId: PROPERTY,
      logoSaved: false,
    });
  });

  it("saves another currency only when the owner chose one", async () => {
    const d = deps();
    await saveQuickHotel(
      input({
        draft: { ...DRAFT, countryCode: "DE", currency: "CHF" },
        currency: quickHotelCurrency("DE", "CHF")!,
      }),
      d,
    );
    expect(d.saveCurrency).toHaveBeenCalledWith(PROPERTY, "CHF");
  });

  it("maps the draft to the create request", () => {
    expect(quickHotelProfileRequest(DRAFT, quickHotelCurrency("DE", "")!, "de")).toEqual({
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      location: {
        countryCode: "DE",
        city: "Munich",
        streetAddress: "Sendlinger Straße 12",
        postalCode: "80331",
        timezone: "Europe/Berlin",
        latitude: 48.135,
        longitude: 11.567,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        { channelType: "phone", value: "+49 89 1234567", purpose: "general", isPublic: true },
        {
          channelType: "email",
          value: "reception@alpenrose.example",
          purpose: "general",
          isPublic: true,
        },
      ],
      initialLaunchSettings: {
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        defaultLanguage: "de",
        supportedLanguages: ["de"],
        instagram: "",
        facebook: "",
        tiktok: "",
        youtube: "",
      },
    });
  });
});
