import { describe, expect, it } from "vitest";

import deMessages from "@/messages/de.json";
import { PmsPropertySelectionRequiredError } from "@/services/api/pmsPropertyClient";
import { errorText, PricingError } from "./pricingAmounts";

const german = (key: string) => (deMessages as Record<string, string>)[key] ?? key;

describe("pricing errorText", () => {
  it("shows the property-selection error in the selected language", () => {
    const error = new PmsPropertySelectionRequiredError("loading pricing");

    expect(errorText(error, german, "pricing.page.loadFailed")).toBe(
      "Wählen Sie eine Unterkunft aus, um fortzufahren.",
    );
  });

  it("keeps pricing errors translated and other messages unchanged", () => {
    expect(
      errorText(new PricingError("pricing.page.loadFailed"), german, "pricing.page.loadFailed"),
    ).toBe(german("pricing.page.loadFailed"));
    expect(errorText(new Error("Rate conflict"), german, "pricing.page.loadFailed")).toBe(
      "Rate conflict",
    );
    expect(errorText("offline", german, "pricing.page.loadFailed")).toBe(
      german("pricing.page.loadFailed"),
    );
  });
});
