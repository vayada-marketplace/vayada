#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SERVICE_KEYS,
  assembleManifest,
  parseArgs,
  requiredOption,
  sha256,
  stableJson,
  validateManifest,
} from "./lib.mjs";

const options = parseArgs(process.argv.slice(2));
const selection = JSON.parse(readFileSync(requiredOption(options, "selection"), "utf8"));
const baselinePath = options.get("baseline");
const baseline =
  baselinePath && existsSync(baselinePath)
    ? validateManifest(JSON.parse(readFileSync(baselinePath, "utf8")))
    : null;
if (selection.baselineAccepted !== Boolean(baseline)) {
  throw new Error("selection and accepted baseline disagree");
}

const imageDirectory = requiredOption(options, "images");
const imageRecords = {};
if (existsSync(imageDirectory)) {
  for (const file of readdirSync(imageDirectory, { recursive: true })) {
    if (typeof file !== "string" || !file.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(join(imageDirectory, file), "utf8"));
    if (SERVICE_KEYS.includes(value.service)) imageRecords[value.service] = value;
  }
}
const manifest = assembleManifest({
  selection,
  imageRecords,
  baseline,
  build: {
    runId: Number(requiredOption(options, "run-id")),
    runAttempt: Number(requiredOption(options, "run-attempt")),
    event: requiredOption(options, "event"),
  },
});
const output = requiredOption(options, "output");
const contents = stableJson(manifest);
writeFileSync(output, contents);
writeFileSync(requiredOption(options, "hash-output"), `${sha256(contents)}  manifest.json\n`);
console.log(`${manifest.manifestId} ${sha256(contents)}`);
