import { describe, expect, it } from "vitest";
import {
  checkNearbyCurationWrite,
  mergeNearbyCurationWrite,
  parseNearbyCurationWrite,
  type NearbyCurationWrite,
  type NearbyCurationState,
} from "./propertyNearby.js";

const custom = {
  id: "a0000000-0000-4000-8000-000000000001",
  category: "nature" as const,
  name: " Beach ",
  address: null,
  latitude: 0,
  longitude: 0,
  hidden: false,
  favorite: false,
  note: null,
};
const choice = {
  placeId: "google_place",
  category: "food" as const,
  hidden: false,
  favorite: false,
  added: false,
  note: null,
};
const request = (): NearbyCurationWrite => ({
  schemaVersion: 1,
  expectedProfileRevision: 3,
  expectedCurationRevision: 0,
  choices: [{ ...choice }],
  customPlaces: [{ ...custom }],
});
const state = (): NearbyCurationState => ({
  schemaVersion: 1,
  profileRevision: 3,
  curationRevision: 0,
  savedProfileRevision: null,
  choices: [],
  customPlaces: [],
  customCategories: [],
  categoryNames: {},
});
const music = {
  id: "c0000000-0000-4000-8000-000000000001",
  name: " Live music ",
  color: "pink" as const,
  icon: "musical-note" as const,
};

describe("nearby curation trust boundary", () => {
  it("accepts address-only curation and snapshots independent hotel content", () => {
    expect(parseNearbyCurationWrite({ ...request(), choices: [], customPlaces: [] }).ok).toBe(true);
    const input = request();
    const parsed = parseNearbyCurationWrite(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("valid request rejected");
    input.customPlaces[0].name = "changed";
    expect(parsed.value.customPlaces[0].name).toBe("Beach");
    expect(parsed.value.customPlaces[0].latitude).toBe(0);
    expect(parsed.value.choices?.[0]?.favorite).toBe(false);
  });
  it.each([NaN, Infinity, 91, -91, "0", null])("rejects invalid latitude %s", (latitude) => {
    expect(
      parseNearbyCurationWrite({ ...request(), customPlaces: [{ ...custom, latitude }] }).ok,
    ).toBe(false);
  });
  it.each([181, -181, Infinity, "0"])("rejects invalid longitude %s", (longitude) => {
    expect(
      parseNearbyCurationWrite({ ...request(), customPlaces: [{ ...custom, longitude }] }).ok,
    ).toBe(false);
  });
  it("rejects unknown fields, contradictory controls, markup and invalid categories", () => {
    for (const patch of [
      { hidden: true, favorite: true },
      { category: "hotel" },
      { note: "<script>alert(1)</script>" },
      { note: "x".repeat(501) },
      { name: "   " },
      { id: "not-a-uuid" },
      { latitude: undefined },
      { providerName: "copied" },
    ]) {
      expect(
        parseNearbyCurationWrite({ ...request(), customPlaces: [{ ...custom, ...patch }] }).ok,
      ).toBe(false);
    }
    expect(parseNearbyCurationWrite({ ...request(), organizationId: "other" }).ok).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        choices: [{ ...choice, hidden: true, favorite: true }],
      }).ok,
    ).toBe(false);
  });
  it("rejects duplicate references, including UUID case aliases, and bounds additions", () => {
    expect(parseNearbyCurationWrite({ ...request(), choices: [choice, choice] }).ok).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        customPlaces: [custom, { ...custom, id: custom.id.toUpperCase() }],
      }).ok,
    ).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        choices: Array.from({ length: 20 }, (_, i) => ({
          ...choice,
          placeId: `id_${i}`,
          added: true,
        })),
      }).ok,
    ).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        choices: Array.from({ length: 101 }, (_, i) => ({ ...choice, placeId: `id_${i}` })),
      }).ok,
    ).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, NaN, "3"])(
    "rejects revision %s",
    (expectedProfileRevision) => {
      expect(parseNearbyCurationWrite({ ...request(), expectedProfileRevision }).ok).toBe(false);
      expect(
        parseNearbyCurationWrite({
          ...request(),
          expectedCurationRevision: expectedProfileRevision,
        }).ok,
      ).toBe(false);
    },
  );
  it("enforces UTF-8 payload size even when each field is within its character limit", () => {
    const result = parseNearbyCurationWrite({
      ...request(),
      choices: Array.from({ length: 100 }, (_, i) => ({
        ...choice,
        placeId: `id_${i}`,
        note: "海".repeat(500),
      })),
    });
    expect(result).toEqual({ ok: false, code: "payload_too_large" });
  });
  it("checks both revisions before accepting property-scoped provider references", () => {
    expect(checkNearbyCurationWrite(request(), state(), new Set([choice.placeId]))).toBeNull();
    expect(checkNearbyCurationWrite(request(), { ...state(), profileRevision: 4 }, new Set())).toBe(
      "revision_conflict",
    );
    expect(
      checkNearbyCurationWrite(request(), { ...state(), curationRevision: 1 }, new Set()),
    ).toBe("revision_conflict");
    expect(
      checkNearbyCurationWrite(request(), { ...state(), choices: [choice] }, new Set()),
    ).toBeNull();
  });
  it("rejects fabricated IDs even when first submitted as hidden, not added", () => {
    for (const flags of [{ hidden: true, added: false }, { favorite: true }, { added: true }]) {
      expect(
        checkNearbyCurationWrite(
          { ...request(), choices: [{ ...choice, ...flags }] },
          state(),
          new Set(["other_property_place"]),
        ),
      ).toBe("unknown_place");
    }
    expect(checkNearbyCurationWrite({ ...request(), choices: [] }, state(), new Set())).toBeNull();
  });
});

describe("nearby categories, order and tips (VAY-2326)", () => {
  const parse = (patch: Record<string, unknown>) =>
    parseNearbyCurationWrite({ ...request(), ...patch });
  it("accepts the host's own categories and names for the four, in order", () => {
    const parsed = parse({
      customCategories: [{ ...music, id: music.id.toUpperCase() }],
      categoryNames: { transport: " Getting here ", food: "Street food" },
      customPlaces: [
        { ...custom, category: music.id.toUpperCase() },
        { ...custom, id: "a0000000-0000-4000-8000-000000000002", category: "food" },
      ],
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        customCategories: [
          { id: music.id, name: "Live music", color: "pink", icon: "musical-note" },
        ],
        categoryNames: { food: "Street food", transport: "Getting here" },
        customPlaces: [{ category: music.id }, { category: "food" }],
      },
    });
  });
  it("rejects a ninth category, unknown colours, icons, keys and names, and places in no category", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      ...music,
      id: `c0000000-0000-4000-8000-00000000000${i}`,
    }));
    for (const patch of [
      { customCategories: nine },
      { customCategories: [{ ...music, color: "#DB2777" }] },
      { customCategories: [{ ...music, color: "orange" }] },
      { customCategories: [{ ...music, icon: "skull" }] },
      { customCategories: [{ ...music, name: "x".repeat(25) }] },
      { customCategories: [{ ...music, name: "  " }] },
      { customCategories: [{ ...music, sortOrder: 1 }] },
      { customCategories: [music, { ...music, id: music.id.toUpperCase() }] },
      { categoryNames: { hotel: "Rooms" } },
      { categoryNames: { food: "" } },
      { categoryNames: [] },
      { customCategories: [], customPlaces: [{ ...custom, category: music.id }] },
      { customPlaces: [{ ...custom, category: "Live music" }] },
    ])
      expect(parse(patch), JSON.stringify(patch)).toEqual({ ok: false, code: "invalid_request" });
  });
  it("keeps the saved Google choices and categories when a write leaves them out", () => {
    const write: Partial<NearbyCurationWrite> = request();
    delete write.choices;
    const without = parseNearbyCurationWrite(write);
    if (!without.ok) throw new Error("valid request rejected");
    expect(Object.keys(without.value)).not.toContain("choices");
    const saved = {
      ...state(),
      choices: [
        { ...choice, hidden: true },
        { ...choice, placeId: "favorite", favorite: true },
      ],
      customCategories: [{ ...music, name: "Live music" }],
      categoryNames: { food: "Street food" },
    };
    expect(mergeNearbyCurationWrite(without.value, saved)).toEqual({
      choices: saved.choices,
      customPlaces: without.value.customPlaces,
      customCategories: saved.customCategories,
      categoryNames: saved.categoryNames,
    });
    // The saved categories count, and so do the saved Google additions.
    expect(
      checkNearbyCurationWrite(
        { ...without.value, customPlaces: [{ ...custom, category: music.id }] },
        saved,
        new Set(),
      ),
    ).toBeNull();
    expect(
      checkNearbyCurationWrite(
        { ...without.value, customPlaces: [{ ...custom, category: music.id }] },
        state(),
        new Set(),
      ),
    ).toBe("invalid_request");
    const added = Array.from({ length: 20 }, (_, i) => ({
      ...choice,
      placeId: `added_${i}`,
      added: true,
    }));
    expect(checkNearbyCurationWrite(without.value, { ...state(), choices: added }, new Set())).toBe(
      "invalid_request",
    );
  });
  it("counts the kept Google choices toward the size limit every read checks", () => {
    const saved = {
      ...state(),
      choices: Array.from({ length: 40 }, (_, i) => ({
        ...choice,
        placeId: `id_${i}`,
        note: "海".repeat(500),
      })),
    };
    const places = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...custom,
        id: `a0000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        note: "海".repeat(140),
      }));
    const write: Partial<NearbyCurationWrite> = { ...request(), customPlaces: places(20) };
    delete write.choices;
    const parsed = parseNearbyCurationWrite(write);
    if (!parsed.ok) throw new Error("valid request rejected");
    expect(checkNearbyCurationWrite(parsed.value, saved, new Set())).toBe("payload_too_large");
    expect(
      checkNearbyCurationWrite({ ...parsed.value, customPlaces: places(1) }, saved, new Set()),
    ).toBeNull();
  });
  it("takes tips up to 140 characters, and keeps a longer note only as it was saved", () => {
    const tip = "x".repeat(140);
    const long = "y".repeat(500);
    const write = (note: string, choiceNote: string | null = null) => ({
      ...request(),
      choices: [{ ...choice, note: choiceNote }],
      customPlaces: [{ ...custom, note }],
    });
    const saved = {
      ...state(),
      choices: [{ ...choice, note: long }],
      customPlaces: [{ ...custom, name: "Beach", note: long }],
    };
    const known = new Set([choice.placeId]);
    expect(checkNearbyCurationWrite(write(tip), state(), known)).toBeNull();
    expect(checkNearbyCurationWrite(write(`${tip}x`), state(), known)).toBe("invalid_request");
    expect(checkNearbyCurationWrite(write(long, long), saved, known)).toBeNull();
    expect(checkNearbyCurationWrite(write(`${long.slice(1)}z`), saved, known)).toBe(
      "invalid_request",
    );
    expect(checkNearbyCurationWrite(write(tip, `${long.slice(1)}z`), saved, known)).toBe(
      "invalid_request",
    );
    // Another place can't take over a saved long note.
    expect(
      checkNearbyCurationWrite(
        {
          ...write(long),
          customPlaces: [{ ...custom, id: "a0000000-0000-4000-8000-000000000009", note: long }],
        },
        saved,
        known,
      ),
    ).toBe("invalid_request");
  });
});
