import { describe, expect, it } from "vitest";

import {
  isPropertyLocationChangeRefusal,
  parseCreatePropertyProfileRequest,
  parsePropertyProfileResponse,
  parsePropertyLocationChangeConfirmation,
  parseUpdatePropertyProfileRequest,
  type PropertyProfileResponse,
} from "./propertyProfile.js";

const response: PropertyProfileResponse = {
  propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  profileRevision: 3,
  profile: {
    displayName: "Hotel Alpenrose",
    propertyType: "hotel",
    location: {
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      city: "Munich",
      countryCode: "DE",
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: [
      {
        channelType: "email",
        value: "hello@alpenrose.example",
        purpose: "guest",
        isPublic: false,
      },
    ],
  },
};

describe("canonical property profile wire contract", () => {
  it("accepts stored incomplete profiles on reads while keeping create writes strict", () => {
    const incomplete = {
      propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      profileRevision: 1,
      profile: {
        displayName: "",
        propertyType: "",
        location: {
          streetAddress: "",
          postalCode: "",
          city: "",
          countryCode: "",
          timezone: "",
          latitude: null,
          longitude: null,
          localityPublic: false,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
        contacts: [],
      },
    };

    expect(parsePropertyProfileResponse(incomplete)).toEqual(incomplete);
    expect(parseCreatePropertyProfileRequest(incomplete.profile)).toBeNull();
  });

  it("accepts a hotel without a postal code (VAY-2289)", () => {
    const withoutPostalCode = {
      ...response.profile,
      location: { ...response.profile.location, postalCode: "" },
    };
    expect(parseCreatePropertyProfileRequest(withoutPostalCode)).toEqual(withoutPostalCode);
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 2,
        patch: { location: { postalCode: "" } },
      }),
    ).not.toBeNull();
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 2,
        patch: { location: { streetAddress: "" } },
      }),
    ).toBeNull();
  });

  it("parses only the exact nested create profile", () => {
    expect(parseCreatePropertyProfileRequest(response.profile)).toEqual(response.profile);
    expect(
      parseCreatePropertyProfileRequest({
        ...response.profile,
        website: "https://legacy.example",
      }),
    ).toBeNull();
  });

  it("accepts initial localization/social settings only on create requests", () => {
    const initialLaunchSettings = {
      defaultCurrency: "LKR",
      supportedCurrencies: ["USD"],
      defaultLanguage: "en",
      supportedLanguages: ["si"],
      instagram: "https://instagram.com/example",
      facebook: "",
      tiktok: "",
      youtube: "",
    };
    const profile = { ...response.profile, initialLaunchSettings };
    expect(parseCreatePropertyProfileRequest(profile)).toEqual(profile);
    expect(parsePropertyProfileResponse({ ...response, profile })).toBeNull();
    for (const invalid of [
      null,
      { ...initialLaunchSettings, pricingCurrency: "USD" },
      { ...initialLaunchSettings, organizationId: "other" },
      { ...initialLaunchSettings, supportedCurrencies: [null] },
      { ...initialLaunchSettings, instagram: "javascript:alert(1)" },
      { ...initialLaunchSettings, youtube: "https://user:password@example.com" },
      { ...initialLaunchSettings, defaultLanguage: "" },
    ]) {
      expect(
        parseCreatePropertyProfileRequest({ ...profile, initialLaunchSettings: invalid }),
      ).toBeNull();
    }
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { initialLaunchSettings },
      }),
    ).toBeNull();
  });

  it("parses the nested response including revision and contact metadata", () => {
    expect(parsePropertyProfileResponse(response)).toEqual(response);
    expect(
      parsePropertyProfileResponse({
        ...response,
        profile: {
          ...response.profile,
          contacts: [{ channelType: "email", value: "owner@example.com", isPublic: false }],
        },
      }),
    ).toBeNull();
  });

  it("accepts sparse update patches and rejects unknown top-level fields", () => {
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { location: { localityPublic: true } },
      }),
    ).toEqual({
      expectedProfileRevision: 3,
      patch: { location: { localityPublic: true } },
    });
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { displayName: "Alpenrose" },
        unexpected: true,
      }),
    ).toBeNull();
  });

  it("reads and writes the area and arrival directions, both optional (VAY-2322)", () => {
    const located = {
      ...response,
      profile: {
        ...response.profile,
        location: {
          ...response.profile.location,
          area: "Altstadt",
          arrivalDirections: "Blue gate.",
        },
      },
    };
    expect(parsePropertyProfileResponse(located)).toEqual(located);
    // Servers from before read back without them.
    expect(parsePropertyProfileResponse(response)).toEqual(response);
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { location: { area: "", arrivalDirections: "Turn at the temple." } },
      }),
    ).not.toBeNull();
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { location: { area: 7 } },
      }),
    ).toBeNull();
  });

  it("rejects the removed addressPublic compatibility field", () => {
    expect(
      parseCreatePropertyProfileRequest({
        ...response.profile,
        location: {
          ...response.profile.location,
          localityPublic: undefined,
          addressPublic: true,
        },
      }),
    ).toBeNull();
    expect(
      parseUpdatePropertyProfileRequest({
        expectedProfileRevision: 3,
        patch: { location: { addressPublic: true } },
      }),
    ).toBeNull();
  });
});

describe("location change refusals (VAY-2582)", () => {
  it("names the profile save's time zone and country refusals, and nothing else", () => {
    for (const code of [
      "location_change_needs_confirmation",
      "channex_time_zone_mismatch",
      "channex_time_zone_unavailable",
    ])
      expect(isPropertyLocationChangeRefusal(code)).toBe(true);
    for (const code of ["profile_revision_conflict", "private_contact_conflict", undefined, null])
      expect(isPropertyLocationChangeRefusal(code)).toBe(false);
  });

  it("sends the person's confirmation with a save, and nothing but true or false", () => {
    const save = { expectedProfileRevision: 3, patch: { location: { timezone: "Europe/London" } } };
    expect(parseUpdatePropertyProfileRequest({ ...save, confirmLocationChange: true })).toEqual({
      ...save,
      confirmLocationChange: true,
    });
    expect(
      parseUpdatePropertyProfileRequest({ ...save, confirmLocationChange: false }),
    ).not.toBeNull();
    expect(parseUpdatePropertyProfileRequest(save)).toEqual(save);
    for (const confirmLocationChange of ["true", 1, null])
      expect(parseUpdatePropertyProfileRequest({ ...save, confirmLocationChange })).toBeNull();
  });

  it("reads what a live hotel's save asks the person to confirm", () => {
    const answer = (changes: unknown) => ({
      code: "location_change_needs_confirmation",
      detail: "This changes your live hotel's time zone from Asia/Colombo to Europe/London.",
      changes,
    });
    expect(
      parsePropertyLocationChangeConfirmation(
        answer({
          timezone: { from: "Asia/Colombo", to: "Europe/London" },
          countryCode: { from: "LK", to: "GB" },
        }),
      ),
    ).toEqual({
      timezone: { from: "Asia/Colombo", to: "Europe/London" },
      countryCode: { from: "LK", to: "GB" },
    });
    expect(
      parsePropertyLocationChangeConfirmation(answer({ countryCode: { from: "LK", to: "GB" } })),
    ).toEqual({ countryCode: { from: "LK", to: "GB" } });
    // Any other answer, or one that names no change, asks nothing.
    for (const value of [
      answer({}),
      answer({ timezone: { from: "Asia/Colombo" } }),
      answer({ timezone: { from: "", to: "Europe/London" } }),
      answer({ city: { from: "Dikwella", to: "Sheffield" } }),
      answer(null),
      { ...answer({ countryCode: { from: "LK", to: "GB" } }), code: "channex_time_zone_mismatch" },
      undefined,
      "location_change_needs_confirmation",
    ])
      expect(parsePropertyLocationChangeConfirmation(value)).toBeNull();
  });
});
