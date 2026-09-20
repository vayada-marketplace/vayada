import { describe, expect, it } from "vitest";

import { collapseOccupiedInventoryChanges } from "./pmsOccupiedInventorySideEffects.js";

const change = (roomTypeId: string, stayDate: string) => ({
  roomTypeId,
  stayDate,
});

describe("occupied inventory ARI range collapse", () => {
  it("sorts deterministically, removes duplicate days, and preserves holes", () => {
    expect(
      collapseOccupiedInventoryChanges([
        change("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "2026-08-04"),
        change("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "2026-08-03"),
        change("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "2026-08-01"),
        change("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "2026-08-03"),
        change("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "2026-08-02"),
        change("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "2026-08-02"),
        change("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "2026-08-05"),
      ]),
    ).toEqual([
      {
        roomTypeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        from: "2026-08-01",
        through: "2026-08-03",
      },
      {
        roomTypeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        from: "2026-08-05",
        through: "2026-08-05",
      },
      {
        roomTypeId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        from: "2026-08-03",
        through: "2026-08-04",
      },
    ]);
  });
});
