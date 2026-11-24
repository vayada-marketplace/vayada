import fs from "node:fs";
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
const en = translator(enMessages);
const de = translator(deMessages);

describe("notProvidedByChannel (VAY-2577)", () => {
  it("names the channel that sent no email, in English and German", () => {
    expect(notProvidedByChannel("airbnb", "email", en)).toBe("Not provided by Airbnb");
    expect(notProvidedByChannel("booking.com", "email", en)).toBe("Not provided by Booking.com");
    expect(notProvidedByChannel("booking_com", "email", de)).toBe(
      "Nicht von Booking.com übermittelt",
    );
    expect(notProvidedByChannel("Airbnb", "email", de)).toBe("Nicht von Airbnb übermittelt");
  });

  it("says where a Booking.com or Airbnb host still sees the phone", () => {
    expect(notProvidedByChannel("booking.com", "phone", en)).toBe(
      "Not provided by Booking.com – see the Booking.com extranet",
    );
    expect(notProvidedByChannel("Airbnb", "phone", en)).toBe(
      "Not provided by Airbnb – see the Airbnb app",
    );
    expect(notProvidedByChannel("booking_com", "phone", de)).toBe(
      "Nicht von Booking.com übermittelt – siehe Booking.com-Extranet",
    );
    expect(notProvidedByChannel("airbnb", "phone", de)).toBe(
      "Nicht von Airbnb übermittelt – siehe Airbnb-App",
    );
  });

  it("keeps the plain wording for other channels' phones", () => {
    expect(notProvidedByChannel("expedia", "phone", en)).toBe("Not provided by Expedia");
    expect(notProvidedByChannel("agoda", "phone", en)).toBe("Not provided by Agoda");
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
      for (const field of ["email", "phone"] as const)
        expect(notProvidedByChannel(channel, field, en)).toBeNull();
  });
});

describe("phone wording in every PMS language (VAY-2577)", () => {
  it("is translated in each catalog and keeps the channel name", () => {
    const dir = new URL("../../messages/", import.meta.url);
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(10);
    for (const file of files) {
      const messages = JSON.parse(fs.readFileSync(new URL(file, dir), "utf8"));
      expect(messages["bookings.detail.phoneNotProvidedByBookingCom"], file).toMatch(
        /Booking\.com.*Booking\.com/,
      );
      expect(messages["bookings.detail.phoneNotProvidedByAirbnb"], file).toMatch(/Airbnb.*Airbnb/);
    }
  });
});
