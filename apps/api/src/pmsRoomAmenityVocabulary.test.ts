import { parsePmsRoomAmenityKey, type PmsRoomAmenityKey } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import {
  PMS_ROOM_AMENITY_KEYS_V1,
  createPmsRoomAmenityVocabularyValidationPort,
  toPublicPmsRoomAmenityLabelsV1,
} from "./domains/pmsRoomAmenityVocabulary.js";

function key(value: string): PmsRoomAmenityKey {
  const parsed = parsePmsRoomAmenityKey(value);
  if (!parsed) throw new Error(`Test key is syntactically invalid: ${value}`);
  return parsed;
}

describe("PMS room amenity vocabulary", () => {
  const vocabulary = createPmsRoomAmenityVocabularyValidationPort();

  it("accepts every explicit V1 room choice", async () => {
    expect(Object.isFrozen(PMS_ROOM_AMENITY_KEYS_V1)).toBe(true);
    expect(PMS_ROOM_AMENITY_KEYS_V1).toEqual([...PMS_ROOM_AMENITY_KEYS_V1].sort());
    expect(new Set(PMS_ROOM_AMENITY_KEYS_V1).size).toBe(PMS_ROOM_AMENITY_KEYS_V1.length);
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("wifi"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("air_conditioning"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("tv"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("balcony"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("kitchen"));

    for (const supported of PMS_ROOM_AMENITY_KEYS_V1) {
      await expect(vocabulary.validateRoomAmenities([supported])).resolves.toEqual({ ok: true });
    }
    await expect(vocabulary.validateRoomAmenities(PMS_ROOM_AMENITY_KEYS_V1)).resolves.toEqual({
      ok: true,
    });
  });

  it("accepts the host's own amenities as typed (VAY-2490)", async () => {
    const input = Object.freeze([
      key("wifi"),
      key("Reception"),
      key("Scooter Rental"),
      key("Massage Service"),
      key("Mobile Concierge Service"),
      key("parking"),
    ]);
    const before = [...input];

    await expect(vocabulary.validateRoomAmenities(input)).resolves.toEqual({ ok: true });
    expect(input).toEqual(before);
  });

  it("refuses values the room amenity contract can't read, once and in code-unit order", async () => {
    const unreadable = ["Spa\nPool", " Reception", "<b>Spa</b>"] as PmsRoomAmenityKey[];

    const result = await vocabulary.validateRoomAmenities([
      key("wifi"),
      ...unreadable,
      unreadable[0]!,
    ]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unsupported_room_amenity_keys",
        unsupportedAmenityKeys: [" Reception", "<b>Spa</b>", "Spa\nPool"],
      },
    });
    expect(result.ok || Object.isFrozen(result.error.unsupportedAmenityKeys)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("publishes stable guest-facing labels instead of sorted internal keys", () => {
    expect(toPublicPmsRoomAmenityLabelsV1(["balcony", "wifi", "air_conditioning"])).toEqual([
      "Wi-Fi",
      "Air conditioning",
      "Balcony",
    ]);
  });

  it("shows the host's own amenities as typed after the vocabulary, each name once", () => {
    expect(
      toPublicPmsRoomAmenityLabelsV1([
        "Massage Service",
        "Reception",
        "Scooter Rental",
        "wifi",
        "Wi-Fi",
        "reception",
        "balcony",
      ]),
    ).toEqual(["Wi-Fi", "Balcony", "Massage Service", "Reception", "Scooter Rental"]);
  });

  it.each([
    ["bathroom type", ["private_bathroom", "shared_bathroom"]],
    ["deferred room features", ["room_features", "mountain_view", "private_entrance"]],
    ["property facilities", ["breakfast", "concierge", "parking", "spa", "swimming_pool"]],
  ])("no longer refuses %s a host keeps on the room", async (_category, values) => {
    await expect(vocabulary.validateRoomAmenities(values.map(key))).resolves.toEqual({
      ok: true,
    });
  });
});
