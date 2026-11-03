import { describe, expect, it } from "vitest";

import { EMPTY_QUICK_HOTEL_DRAFT, type QuickHotelDraft } from "../quick/quickHotelDraft";
import {
  hotelDetailsStepToFinish,
  locationStepHint,
  propertyStepHint,
  setupDraftFromProfile,
  setupProfilePatch,
  socialLinkValid,
} from "./setupDraft";

const FULL: QuickHotelDraft = {
  ...EMPTY_QUICK_HOTEL_DRAFT,
  displayName: "Lumansa Hiriketiya",
  propertyType: "villa",
  streetAddress: "Hiriketiya Road 4",
  city: "Dickwella",
  countryCode: "LK",
  timezone: "Asia/Colombo",
  contactEmail: "stay@lumansa.example",
  phone: "+94 77 308 7696",
};

describe("four-step setup checks (VAY-2451)", () => {
  it("step 1 needs a name and a type, and says which", () => {
    expect(propertyStepHint({ ...FULL, displayName: " " })).toBe(
      "Add your property's name to continue",
    );
    expect(propertyStepHint({ ...FULL, propertyType: "" })).toBe(
      "Choose a property type to continue",
    );
    expect(propertyStepHint(FULL)).toBeNull();
  });

  it("step 2 needs what the server creates the property with, then a sound WhatsApp and full links", () => {
    expect(locationStepHint({ ...FULL, timezone: "" }, true)).toBe("Add your address to continue");
    expect(locationStepHint(FULL, false)).toBe("Add your address to continue");
    expect(locationStepHint({ ...FULL, contactEmail: "stay@" }, true)).toBe(
      "Add a valid reception email to continue",
    );
    expect(locationStepHint({ ...FULL, phone: "" }, true)).toBe(
      "Add a valid reception phone to continue",
    );
    expect(locationStepHint({ ...FULL, whatsappSameAsPhone: false, whatsapp: "12" }, true)).toBe(
      "Check the WhatsApp number, or tick Same as phone",
    );
    expect(locationStepHint({ ...FULL, instagram: "instagram.com/lumansa" }, true)).toBe(
      "Use the full social links, starting with https://",
    );
    expect(
      locationStepHint(
        {
          ...FULL,
          whatsappSameAsPhone: false,
          whatsapp: "",
          tiktok: "https://tiktok.com/@lumansa",
        },
        true,
      ),
    ).toBeNull();
  });

  it("takes only full https social links", () => {
    expect(socialLinkValid("")).toBe(true);
    expect(socialLinkValid(" https://instagram.com/lumansa ")).toBe(true);
    expect(socialLinkValid("http://instagram.com/lumansa")).toBe(false);
    expect(socialLinkValid("@lumansa")).toBe(false);
    expect(socialLinkValid("https://user:pass@instagram.com")).toBe(false);
  });
});

describe("steps 1–2 of a hotel that exists (VAY-2451 resume)", () => {
  const profile = {
    displayName: "Lumansa Hiriketiya",
    propertyType: "villa",
    location: {
      streetAddress: "Hiriketiya Road 4",
      postalCode: "",
      city: "Dickwella",
      countryCode: "LK",
      timezone: "Asia/Colombo",
      latitude: 5.96,
      longitude: 80.71,
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "exact" as const,
    },
    contacts: [
      {
        channelType: "email" as const,
        value: "stay@lumansa.example",
        purpose: "general" as const,
        isPublic: true,
      },
      {
        channelType: "phone" as const,
        value: "+94 77 308 7696",
        purpose: "general" as const,
        isPublic: true,
      },
      {
        channelType: "website" as const,
        value: "https://lumansa.example",
        purpose: "general" as const,
        isPublic: true,
      },
    ],
  };

  it("reads WhatsApp as the phone unless the hotel has another number", () => {
    expect(setupDraftFromProfile(profile, null)).toMatchObject({
      contactEmail: "stay@lumansa.example",
      phone: "+94 77 308 7696",
      whatsappSameAsPhone: true,
      whatsapp: "",
    });
    const other = {
      ...profile,
      contacts: [
        ...profile.contacts,
        {
          channelType: "whatsapp" as const,
          value: "+94 70 000 0000",
          purpose: "general" as const,
          isPublic: true,
        },
      ],
    };
    expect(setupDraftFromProfile(other, null)).toMatchObject({
      whatsappSameAsPhone: false,
      whatsapp: "+94 70 000 0000",
    });
  });

  it("saves WhatsApp with the details and keeps the hotel's other contacts", () => {
    const draft = setupDraftFromProfile(profile, null);
    expect(setupProfilePatch(draft, profile).contacts).toEqual([
      ...profile.contacts,
      { channelType: "whatsapp", value: "+94 77 308 7696", purpose: "general", isPublic: true },
    ]);
    const cleared = setupProfilePatch(
      { ...draft, whatsappSameAsPhone: false, whatsapp: " " },
      {
        ...profile,
        contacts: [
          ...profile.contacts,
          { channelType: "whatsapp", value: "+94 70 000 0000", purpose: "general", isPublic: true },
        ],
      },
    );
    expect(cleared.contacts?.map((contact) => contact.channelType)).toEqual([
      "email",
      "phone",
      "website",
    ]);
  });

  it("says which of steps 1–2 an older setup's hotel still lacks", () => {
    const draft = setupDraftFromProfile(profile, null);
    expect(hotelDetailsStepToFinish(draft)).toBeNull();
    expect(hotelDetailsStepToFinish({ ...draft, propertyType: "" })).toBe("property");
    expect(hotelDetailsStepToFinish({ ...draft, streetAddress: "" })).toBe("location");
    expect(hotelDetailsStepToFinish({ ...draft, phone: "" })).toBe("location");
  });
});
