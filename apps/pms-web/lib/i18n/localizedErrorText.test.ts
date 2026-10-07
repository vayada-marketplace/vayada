import { describe, expect, it } from "vitest";

import deMessages from "../../messages/de.json";
import enMessages from "../../messages/en.json";
import { PmsPropertySelectionRequiredError } from "@/services/api/pmsPropertyClient";
import { localizedErrorText } from "./localizedErrorText";

const translator = (messages: Record<string, string>) => (key: string) => messages[key] ?? key;

describe("localizedErrorText", () => {
  it("shows the property-selection error in the selected language", () => {
    const error = new PmsPropertySelectionRequiredError("loading rooms");

    expect(localizedErrorText(error, error.message, translator(deMessages))).toBe(
      "Wählen Sie eine Unterkunft aus, um fortzufahren.",
    );
    expect(localizedErrorText(error, error.message, translator(enMessages))).toBe(
      "Select a property to continue.",
    );
  });

  it("keeps the page's text for other errors", () => {
    expect(
      localizedErrorText(new Error("Room type not found"), "Shown text", translator(deMessages)),
    ).toBe("Shown text");
  });
});
