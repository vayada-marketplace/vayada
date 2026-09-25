import { createHash } from "node:crypto";

import type { SourceInventoryEntry } from "./sourceInventory.js";

const HEADERS =
  "source_database\tobject_name\tdisposition\ttarget_input\tactivation_rule\tparity_rule";
const TABLES = new Set(
  ["public", "inbox_prototype_archive_20260905"].flatMap((schema) =>
    ["automation_sends", "guest_automations", "message_templates"].map(
      (table) => `${schema}.${table}`,
    ),
  ),
);
const ACTIVATION_RULES: Record<string, string> = {
  automation_sends: "never_enqueue",
  guest_automations: "never_schedule",
  message_templates: "never_activate",
};

export function historicalSourceInventorySha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseHistoricalSourceInventory(text: string): SourceInventoryEntry[] {
  const [header, ...lines] = text.trimEnd().split(/\r?\n/);
  if (header !== HEADERS || lines.length !== TABLES.size) {
    throw new Error("historical source inventory does not match the reviewed contract");
  }
  const found = new Set<string>();
  const entries = lines.map((line) => {
    const cells = line.split("\t");
    const [database, objectName, disposition, targetInput, activationRule, parityRule] = cells;
    const [schema, table] = objectName?.split(".") ?? [];
    const expectedParity =
      table === "automation_sends"
        ? schema === "public"
          ? "compare_ids_with_archive_before_dedup"
          : "compare_ids_with_public_before_dedup"
        : "count_and_checksum";
    if (
      cells.length !== 6 ||
      database !== "pms" ||
      !TABLES.has(objectName) ||
      found.has(objectName) ||
      disposition !== "historical_snapshot" ||
      targetInput !== "none" ||
      activationRule !== ACTIVATION_RULES[table ?? ""] ||
      parityRule !== expectedParity
    ) {
      throw new Error("historical source inventory has an unknown or unsafe disposition");
    }
    found.add(objectName);
    return {
      sourceDatabase: "pms",
      objectType: "table",
      objectName,
      lifecycle: "active",
      disposition: "snapshot_only",
      targetOwner: "none",
      fixtureCase: "none",
      parityCategory: "retired-sources",
      piiClass: "pii",
      retentionPolicy: "rollback-window",
      cutoverWriter: "none",
      followUp: "VAY-2042",
    } satisfies SourceInventoryEntry;
  });
  if (found.size !== TABLES.size) {
    throw new Error("historical source inventory is incomplete");
  }
  return entries;
}
