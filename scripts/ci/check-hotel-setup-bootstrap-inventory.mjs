#!/usr/bin/env node
// Formatting and schema check for engineering/hotel-setup-bootstrap-images.json. It mirrors the
// shape scripts/select-hotel-setup-bootstrap-images.py accepts, so an inventory-only PR can skip
// the heavy PR checks without being able to land an entry the publisher would reject.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const INVENTORY_PATH = "engineering/hotel-setup-bootstrap-images.json";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const keysOf = (value) => Object.keys(value).sort().join(",");

export function validateInventory(text) {
  let inventory;
  try {
    inventory = JSON.parse(text);
  } catch (error) {
    return [`not valid JSON: ${error.message}`];
  }
  if (!isRecord(inventory)) return ["inventory must be a JSON object keyed by reviewed pair name"];
  const problems = [];
  if (text !== `${JSON.stringify(inventory, null, 2)}\n`) {
    problems.push("formatting: expected two-space indented JSON with a trailing newline");
  }
  for (const [pair, entry] of Object.entries(inventory)) {
    if (!isRecord(entry) || keysOf(entry) !== "primary,rollback") {
      problems.push(`${pair}: must have exactly "primary" and "rollback"`);
      continue;
    }
    for (const mode of ["primary", "rollback"]) {
      const image = entry[mode];
      if (!isRecord(image) || keysOf(image) !== "digest,source") {
        problems.push(`${pair}.${mode}: must have exactly "digest" and "source"`);
        continue;
      }
      if (typeof image.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image.digest)) {
        problems.push(`${pair}.${mode}.digest: must be an immutable sha256 digest`);
      }
      if (typeof image.source !== "string" || !/^[a-f0-9]{40}$/.test(image.source)) {
        problems.push(`${pair}.${mode}.source: must be a 40-character commit sha`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = validateInventory(readFileSync(INVENTORY_PATH, "utf8"));
  for (const problem of problems) console.error(`::error file=${INVENTORY_PATH}::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`${INVENTORY_PATH} is well-formed`);
}
