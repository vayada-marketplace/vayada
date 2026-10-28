import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OtaCommissionSettingsSection } from "@/components/settings/OtaCommissionSettingsSection";
import { PmsAccessProvider } from "./PmsAccessContext";
import {
  canonicalEffectiveFrom,
  displayPercentage,
  otaCommissionFormErrors,
} from "./otaCommissions";
const renderFor = (permissions: string[]) =>
  renderToStaticMarkup(
    createElement(PmsAccessProvider, {
      access: { membershipId: "member-1", roleKey: "hotel_custom", permissions },
      children: createElement(OtaCommissionSettingsSection),
    }),
  );
describe("PMS OTA commission settings", () => {
  it("accepts precise percentages and valid effective timestamps", () => {
    expect(otaCommissionFormErrors("12.3456", "2026-09-01T12:30")).toEqual({
      percentageRate: "",
      effectiveFrom: "",
    });
    expect(canonicalEffectiveFrom("2026-01-01T00:00")).toBe(new Date(2026, 0).toISOString());
    expect(canonicalEffectiveFrom("2026-02-30T12:30")).toBeNull();
    expect(canonicalEffectiveFrom("2026-09-01")).toBeNull();
    expect(displayPercentage("12.3400")).toBe("12.34");
  });
  it("rejects out-of-range, over-precise, and invalid values", () => {
    expect(otaCommissionFormErrors("101", "not-a-date")).toEqual({
      percentageRate: "Enter a percentage from 0 to 100 with up to four decimal places.",
      effectiveFrom: "Choose a valid effective date and time.",
    });
    expect(otaCommissionFormErrors("10.12345", "2026-09-01T12:30").percentageRate).not.toBe("");
  });
  it("renders an accessible persisted-settings loading state", () => {
    const markup = renderFor(["pms.finance.read", "pms.finance.manage"]);
    // The title and description sit in the page header (VAY-2275), not in the section.
    expect(markup).toContain('id="ota-commissions"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading persisted OTA commission settings");
  });
  it("tells a role without finance access instead of loading the rates (VAY-2154)", () => {
    const markup = renderFor(["pms.settings.read"]);
    expect(markup).toContain('role="note"');
    expect(markup).not.toContain("Loading persisted OTA commission settings");
  });
});
