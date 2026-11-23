import { describe, expect, it } from "vitest";

import deMessages from "../../messages/de.json";
import enMessages from "../../messages/en.json";
import { notProvidedByChannel } from "./channelLabel";

const translator =
  (messages: Record<string, string>) => (key: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      messages[key] ?? key,
    );

describe("notProvidedByChannel (VAY-2577)", () => {
  it("names the channel that sent no email or phone, in English and German", () => {
    expect(notProvidedByChannel("airbnb", translator(enMessages))).toBe("Not provided by Airbnb");
    expect(notProvidedByChannel("booking.com", translator(enMessages))).toBe(
      "Not provided by Booking.com",
    );
    expect(notProvidedByChannel("booking_com", translator(deMessages))).toBe(
      "Nicht von Booking.com übermittelt",
    );
    expect(notProvidedByChannel("Airbnb", translator(deMessages))).toBe(
      "Nicht von Airbnb übermittelt",
    );
  });

  it("keeps direct, desk and unknown sources to their own empty state", () => {
    for (const channel of [
      "direct",
      "manual",
      "migration",
      "other",
      "channex",
      "",
      null,
      undefined,
    ])
      expect(notProvidedByChannel(channel, translator(enMessages))).toBeNull();
  });
});
