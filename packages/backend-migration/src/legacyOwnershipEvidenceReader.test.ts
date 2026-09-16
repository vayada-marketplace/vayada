import { describe, expect, it, vi } from "vitest";
import { hashTargetRow } from "./channexAdoptionManifestCrypto.js";
import {
  readAdoptionTargetRow,
  readLegacyOwnershipTargetRow,
} from "./channexAdoptionTargetRows.js";
import { readLegacyOwnershipDrift } from "./legacyOwnershipEvidenceReader.js";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";

const expected: LegacyOwnershipFingerprint[] = Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).map(
  ([kind, table], index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const [schema, relation] = table.split(".");
    return {
      kind: kind as LegacyOwnershipFingerprint["kind"],
      table,
      id,
      rowStateSha256: hashTargetRow({
        schema: schema!,
        table: relation!,
        primaryKey: id,
        row: { id, status: "pending" },
      }),
    };
  },
);

function database(change?: "status" | "missing" | "duplicate" | "error") {
  const query = vi.fn(async (sql: string, params: string[]) => {
    if (sql.includes("information_schema.columns"))
      return {
        rows: [
          { columnName: "id", dataType: "uuid", udtName: "uuid" },
          { columnName: "status", dataType: "text", udtName: "text" },
        ],
      };
    if (change === "error") throw new Error("synthetic database failure");
    const row = { id: params[0], status: change === "status" ? "suspended" : "pending" };
    return { rows: change === "missing" ? [] : change === "duplicate" ? [row, row] : [row] };
  });
  return { query };
}

describe("ownership drift database reader (mocked PostgreSQL)", () => {
  it("reads and hashes all eight rows in stable order using SELECT only", async () => {
    const client = database();
    expect(await readLegacyOwnershipDrift(client as never, [...expected].reverse())).toEqual({
      outcome: "unchanged",
    });
    expect(client.query).toHaveBeenCalledTimes(16);
    expect(client.query.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT"))).toBe(true);
    expect(
      client.query.mock.calls
        .filter(([sql]) => !sql.includes("information_schema.columns"))
        .map(([, params]) => params[0]),
    ).toEqual(expected.map((row) => row.id));
  });
  it("rejects malformed expected evidence before any SQL", async () => {
    const client = database();
    expect(await readLegacyOwnershipDrift(client as never, expected.slice(1))).toEqual({
      outcome: "blocked",
      reason: "invalid_expected",
    });
    expect(client.query).not.toHaveBeenCalled();
  });
  it("detects a newer target status instead of accepting the approved old hash", async () => {
    expect(await readLegacyOwnershipDrift(database("status") as never, expected)).toEqual({
      outcome: "blocked",
      reason: "target_drift",
    });
  });
  it.each(["missing", "duplicate", "error"] as const)(
    "does not accept %s evidence",
    async (change) => {
      await expect(readLegacyOwnershipDrift(database(change) as never, expected)).rejects.toThrow();
    },
  );
  it("does not broaden the clean-adoption table allowlist", async () => {
    const client = database();
    await expect(
      readAdoptionTargetRow(client as never, "identity.users" as never, expected[0]!.id),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TARGET_TABLE" });
    expect(client.query).not.toHaveBeenCalled();
  });
  it("ownership reader rejects claim tables and malformed IDs before querying", async () => {
    const client = database();
    await expect(
      readLegacyOwnershipTargetRow(
        client as never,
        "pms.channel_binding_claims" as never,
        expected[0]!.id,
      ),
    ).rejects.toThrow();
    await expect(
      readLegacyOwnershipTargetRow(client as never, "identity.users", "invalid"),
    ).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });
});
