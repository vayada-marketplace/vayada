#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { sha256, validateManifest, validatePublishedRecord } from "./lib.mjs";

const [kind, path, expectedHash] = process.argv.slice(2);
if (!new Set(["manifest", "published-record"]).has(kind) || !path) {
  throw new Error("usage: validate.mjs manifest|published-record <path> [sha256]");
}
const contents = readFileSync(path, "utf8");
const value = JSON.parse(contents);
if (kind === "manifest") validateManifest(value);
else validatePublishedRecord(value);
const actualHash = sha256(contents);
if (expectedHash && actualHash !== expectedHash) {
  throw new Error(`hash mismatch: expected ${expectedHash}, got ${actualHash}`);
}
console.log(actualHash);
