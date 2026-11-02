import { describe, expect, it } from "vitest";

import { EMPTY_QUICK_HOTEL_DRAFT, type QuickHotelDraft } from "../quick/quickHotelDraft";
import { locationStepHint, propertyStepHint, socialLinkValid } from "./setupDraft";

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
