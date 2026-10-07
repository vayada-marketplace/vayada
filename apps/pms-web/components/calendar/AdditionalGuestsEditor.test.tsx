import { describe, expect, it } from "vitest";

import { additionalGuestValid, type AdditionalGuestDraft } from "./AdditionalGuestsEditor";

const guest = (patch: Partial<AdditionalGuestDraft>): AdditionalGuestDraft => ({
  key: 1,
  firstName: "Grace",
  lastName: "Hopper",
  email: "",
  phoneCountry: "DE",
  phone: "",
  countryCode: "",
  open: true,
  ...patch,
});

describe("additionalGuestValid", () => {
  it("requires both names and accepts empty optional fields", () => {
    expect(additionalGuestValid(guest({}))).toBe(true);
    expect(additionalGuestValid(guest({ lastName: " " }))).toBe(false);
  });

  it.each(["a@b.c", "josé@example.com", "a..b@x.com", "user@münchen.de", "a@x_y.com", ".a@x.com"])(
    "rejects %s like the API's email rule",
    (email) => expect(additionalGuestValid(guest({ email }))).toBe(false),
  );

  it("accepts ordinary emails and valid phones, rejects invalid phones", () => {
    expect(additionalGuestValid(guest({ email: "grace.hopper+pms@navy.example.com" }))).toBe(true);
    expect(additionalGuestValid(guest({ phone: "089 1234567" }))).toBe(true);
    expect(additionalGuestValid(guest({ phone: "12" }))).toBe(false);
  });
});
