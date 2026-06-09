import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getSmokeFixtureCases } from "../smoke.js";
import { getParityHandlers, getRegisteredFixtureCases, getTransformHandler } from "./registry.js";

type FixtureManifestSummary = {
  caseId: string;
  sourceDatabases: string[];
};

const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures");

async function loadFixtureManifestSummaries(): Promise<FixtureManifestSummary[]> {
  const casesDir = join(FIXTURES_DIR, "cases");
  const entries = (await readdir(casesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const summaries: FixtureManifestSummary[] = [];

  for (const entry of entries) {
    const manifestPath = join(casesDir, entry.name, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      caseId?: unknown;
      sourceDatabases?: unknown;
    };

    if (typeof manifest.caseId !== "string") {
      throw new Error(`${manifestPath} must define a string caseId.`);
    }
    if (manifest.caseId !== entry.name) {
      throw new Error(
        `${manifestPath} caseId "${manifest.caseId}" must match directory "${entry.name}".`,
      );
    }
    if (
      !Array.isArray(manifest.sourceDatabases) ||
      !manifest.sourceDatabases.every((source) => typeof source === "string")
    ) {
      throw new Error(`${manifestPath} must define a string[] sourceDatabases field.`);
    }

    summaries.push({
      caseId: manifest.caseId,
      sourceDatabases: manifest.sourceDatabases,
    });
  }

  return summaries;
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

describe("fixture case registry", () => {
  it("registers every fixture manifest case for full-fixture smoke", async () => {
    const manifestCases = (await loadFixtureManifestSummaries()).map((manifest) => manifest.caseId);

    expect(sorted(getRegisteredFixtureCases())).toEqual(sorted(manifestCases));
    expect(getSmokeFixtureCases()).toEqual(getRegisteredFixtureCases());
  });

  it("registers parity handlers for every fixture manifest case", async () => {
    for (const { caseId } of await loadFixtureManifestSummaries()) {
      expect(getParityHandlers(caseId).length, `${caseId} parity handler count`).toBeGreaterThan(0);
    }
  });

  it("registers transforms only for source-backed fixture cases", async () => {
    for (const { caseId, sourceDatabases } of await loadFixtureManifestSummaries()) {
      const sourceBacked = sourceDatabases.some((source) => source !== "target");

      if (sourceBacked) {
        expect(getTransformHandler(caseId), `${caseId} transform`).toBeTypeOf("function");
      } else {
        expect(getTransformHandler(caseId), `${caseId} transform`).toBeUndefined();
      }
    }
  });

  it("returns empty handlers for unregistered fixture cases", () => {
    expect(getTransformHandler("unknown-fixture")).toBeUndefined();
    expect(getParityHandlers("unknown-fixture")).toEqual([]);
  });
});
