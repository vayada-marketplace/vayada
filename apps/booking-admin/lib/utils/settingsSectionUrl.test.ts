import { describe, expect, it } from "vitest";

import { isSettingsPage, legacySettingsPageUrl, SETTINGS_PAGES } from "./settingsSectionUrl";

describe("settings page URLs", () => {
  it.each(SETTINGS_PAGES)("recognises the %s page", (page) => {
    expect(isSettingsPage(page)).toBe(true);
  });

  it("rejects pages that do not exist", () => {
    for (const page of ["property", "account", "email-notifications", "constructor", ""])
      expect(isSettingsPage(page)).toBe(false);
  });

  it.each([
    ["property", "/settings/general"],
    ["localization", "/settings/general#localization"],
    ["booking", "/settings/booking-rules"],
    ["billing", "/settings/billing"],
    ["payments", "/settings/payments"],
  ])("redirects the legacy %s section to %s", (section, url) => {
    expect(legacySettingsPageUrl(`?section=${section}`)).toBe(url);
  });

  it.each(["return", "refresh"])("keeps a Stripe Connect %s on Payments", (stripe) => {
    expect(legacySettingsPageUrl(`?section=payments&stripe=${stripe}`)).toBe(
      `/settings/payments?stripe=${stripe}`,
    );
    expect(legacySettingsPageUrl(`?stripe=${stripe}`)).toBe(`/settings/payments?stripe=${stripe}`);
  });

  it.each(["success", "canceled", "manage"])("keeps a Stripe billing %s on Billing", (billing) => {
    expect(legacySettingsPageUrl(`?billing=${billing}`)).toBe(
      `/settings/billing?billing=${billing}`,
    );
  });

  it("prefers an explicit section and keeps every other parameter and the hash", () => {
    expect(
      legacySettingsPageUrl("?billing=success&source=email&section=payments", "#details"),
    ).toBe("/settings/payments?billing=success&source=email#details");
    expect(legacySettingsPageUrl("?section=unknown&billing=canceled")).toBe(
      "/settings/billing?billing=canceled",
    );
  });

  it("leaves the card grid alone without a legacy section", () => {
    expect(legacySettingsPageUrl("")).toBeNull();
    expect(legacySettingsPageUrl("?source=email")).toBeNull();
    expect(legacySettingsPageUrl("?section=account")).toBeNull();
    expect(legacySettingsPageUrl("?section=constructor")).toBeNull();
  });
});
