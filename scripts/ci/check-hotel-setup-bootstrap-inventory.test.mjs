import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INVENTORY_PATH, validateInventory } from "./check-hotel-setup-bootstrap-inventory.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const source = "b".repeat(40);
const pair = { primary: { digest, source }, rollback: { digest, source } };
const format = (value) => `${JSON.stringify(value, null, 2)}\n`;

test("the checked-in inventory is well-formed", () => {
  const text = readFileSync(new URL(`../../${INVENTORY_PATH}`, import.meta.url), "utf8");
  assert.deepEqual(validateInventory(text), []);
});

test("a reviewed pair with immutable digests and sources passes", () => {
  assert.deepEqual(validateInventory(format({ "vay965-example-20261007": pair })), []);
});

test("formatting drift is reported", () => {
  assert.deepEqual(validateInventory(JSON.stringify({ pair })), [
    "formatting: expected two-space indented JSON with a trailing newline",
  ]);
});

test("invalid JSON and non-object inventories are rejected", () => {
  assert.match(validateInventory("{")[0], /^not valid JSON/);
  assert.deepEqual(validateInventory(format([])), [
    "inventory must be a JSON object keyed by reviewed pair name",
  ]);
});

test("pairs must carry exactly primary and rollback entries with digest and source", () => {
  assert.deepEqual(validateInventory(format({ p: { primary: pair.primary } })), [
    'p: must have exactly "primary" and "rollback"',
  ]);
  assert.deepEqual(validateInventory(format({ p: { ...pair, rollback: { digest } } })), [
    'p.rollback: must have exactly "digest" and "source"',
  ]);
});

test("mutable tags and short shas are rejected", () => {
  const bad = {
    primary: { digest: "next-latest", source },
    rollback: { digest, source: "abc123" },
  };
  assert.deepEqual(validateInventory(format({ p: bad })), [
    "p.primary.digest: must be an immutable sha256 digest",
    "p.rollback.source: must be a 40-character commit sha",
  ]);
});
