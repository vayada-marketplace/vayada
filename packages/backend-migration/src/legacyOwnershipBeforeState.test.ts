import { describe, expect, it } from "vitest";
import { hashTargetRow } from "./channexAdoptionManifestCrypto.js";
import {
  compareLegacyOwnershipBeforeState,
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
  type LegacyOwnershipRowKind,
} from "./legacyOwnershipBeforeState.js";

const rows: LegacyOwnershipFingerprint[] = Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).map(
  ([kind, qualifiedTable], index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const [schema, table] = qualifiedTable.split(".");
    return {
      kind: kind as LegacyOwnershipRowKind,
      table: qualifiedTable,
      id,
      rowStateSha256: hashTargetRow({
        schema: schema!,
        table: table!,
        primaryKey: id,
        row: { id, status: "pending" },
      }),
    };
  },
);

describe("legacy ownership before-state drift check, not authorization", () => {
  it("accepts a reordered exact set without mutating either input", () => {
    const expected = Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    const observed = Object.freeze([...expected].reverse());
    expect(compareLegacyOwnershipBeforeState(expected, observed)).toEqual({ outcome: "unchanged" });
    expect(expected).toEqual(rows);
  });

  it.each(Object.keys(LEGACY_OWNERSHIP_ROW_TABLES))("rejects changed %s fingerprint", (kind) => {
    const changed = rows.map((row) =>
      row.kind === kind ? { ...row, rowStateSha256: "f".repeat(64) } : row,
    );
    expect(compareLegacyOwnershipBeforeState(rows, changed)).toEqual({
      outcome: "blocked",
      reason: "target_drift",
    });
  });

  it("rejects replacing a row even if the supplied digest is unchanged", () => {
    const changed = rows.map((row) =>
      row.kind === "user" ? { ...row, id: "00000000-0000-4000-8000-000000000099" } : row,
    );
    expect(compareLegacyOwnershipBeforeState(rows, changed)).toEqual({
      outcome: "blocked",
      reason: "target_drift",
    });
  });

  const invalidSets = [
    [],
    rows.slice(1),
    [...rows, rows[0]!],
    [rows[0]!, ...rows.slice(0, -1)],
    rows.map((row) =>
      row.kind === "pmsLink"
        ? { ...row, id: rows.find((item) => item.kind === "legacyLink")!.id }
        : row,
    ),
    rows.map((row) => ({ ...row, table: "identity.wrong_table" })),
    rows.map((row) => ({ ...row, id: "" })),
    rows.map((row) => ({ ...row, rowStateSha256: "invalid" })),
    rows.map((row) => ({ ...row, kind: "unknown" as LegacyOwnershipRowKind })),
  ];
  it.each(invalidSets.map((value, index) => ({ value, index })))(
    "fails closed for malformed set $index",
    ({ value }) => {
      expect(compareLegacyOwnershipBeforeState(value, rows)).toEqual({
        outcome: "blocked",
        reason: "invalid_expected",
      });
      expect(compareLegacyOwnershipBeforeState(rows, value)).toEqual({
        outcome: "blocked",
        reason: "invalid_observed",
      });
    },
  );
});
