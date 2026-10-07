import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseSourceInventory } from "./sourceInventory.js";
import {
  historicalSourceInventorySha256,
  parseHistoricalSourceInventory,
} from "./rawSourceDispositions.js";

const inventory = parseSourceInventory(
  readFileSync(new URL("../source-inventory.tsv", import.meta.url), "utf8"),
);
const historicalText = readFileSync(
  new URL("../raw-source-dispositions.tsv", import.meta.url),
  "utf8",
);
const lines = historicalText.trim().split("\n");
const headers = lines.shift()?.split("\t");
const additions = lines.map((line) => line.split("\t"));

describe("VAY-2042 verified raw-source dispositions", () => {
  it("parses exactly six non-runnable snapshot entries", () => {
    const parsed = parseHistoricalSourceInventory(historicalText);
    expect(parsed).toHaveLength(6);
    expect(parsed.every((entry) => entry.disposition === "snapshot_only")).toBe(true);
    expect(parsed.every((entry) => entry.targetOwner === "none")).toBe(true);
    expect(historicalSourceInventorySha256(historicalText)).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      parseHistoricalSourceInventory(historicalText.replace("never_enqueue", "never_schedule")),
    ).toThrow();
    expect(() =>
      parseHistoricalSourceInventory(historicalText.replace("public.", "other.")),
    ).toThrow();
  });
  it("covers the six observed PMS automation tables without altering VAY-1350", () => {
    expect(headers).toEqual([
      "source_database",
      "object_name",
      "disposition",
      "target_input",
      "activation_rule",
      "parity_rule",
    ]);
    const existing = inventory
      .filter((entry) => entry.objectType === "table" && entry.lifecycle === "active")
      .map((entry) => `${entry.sourceDatabase}:${entry.objectName}`);
    const additional = additions.map(([database, table]) => `${database}:${table}`);
    expect(existing).toHaveLength(77);
    expect(new Set([...existing, ...additional]).size).toBe(83);
    expect(additional.sort()).toEqual(
      ["public", "inbox_prototype_archive_20260905"]
        .flatMap((schema) =>
          ["automation_sends", "guest_automations", "message_templates"].map(
            (table) => `pms:${schema}.${table}`,
          ),
        )
        .sort(),
    );
    for (const row of additions) {
      expect(row).toHaveLength(6);
      expect(row[2]).toBe("historical_snapshot");
      expect(row[3]).toBe("none");
      expect(row[4]).toMatch(/^never_(enqueue|schedule|activate)$/);
    }
  });
});
