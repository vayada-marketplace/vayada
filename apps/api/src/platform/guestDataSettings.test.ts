import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUEST_DATA_SETTINGS,
  guestDataSettingsFrom,
  parseGuestDataSettings,
} from "./guestDataSettings.js";

const valid = {
  fields: {
    email: "required",
    phone: "off",
    nationality: "optional",
    dateOfBirth: "optional",
    documentType: "required",
    documentNumber: "required",
  },
  matching: { email: true, phone: false },
  identityRetentionDays: 30,
};

describe("guest data settings (VAY-2420)", () => {
  it("keeps the defaults for anything not stored, or stored in a shape it doesn't know", () => {
    expect(guestDataSettingsFrom(null)).toEqual(DEFAULT_GUEST_DATA_SETTINGS);
    expect(
      guestDataSettingsFrom({
        fields: { phone: "off", email: "off", nationality: "maybe" },
        matching: { phone: false },
        identityRetentionDays: 14,
      }),
    ).toEqual({
      ...DEFAULT_GUEST_DATA_SETTINGS,
      fields: { ...DEFAULT_GUEST_DATA_SETTINGS.fields, phone: "off" },
      matching: { email: true, phone: false },
    });
  });

  it("accepts a whole settings object and refuses anything else", () => {
    expect(parseGuestDataSettings(valid)).toEqual(valid);
    expect(parseGuestDataSettings({ ...valid, identityRetentionDays: null })).toMatchObject({
      identityRetentionDays: null,
    });
    expect(parseGuestDataSettings({ ...valid, fields: { ...valid.fields, email: "off" } })).toMatch(
      /email can't be off/,
    );
    expect(parseGuestDataSettings({ ...valid, identityRetentionDays: 14 })).toMatch(/7, 30, 90/);
    expect(parseGuestDataSettings({ ...valid, matching: { email: true } })).toMatch(/matching/);
    expect(parseGuestDataSettings({ ...valid, extra: true })).toMatch(/Send fields/);
  });
});
