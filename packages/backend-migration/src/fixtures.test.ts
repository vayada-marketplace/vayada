import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadFixtureCase } from "./fixtures.js";

describe("loadFixtureCase", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `backend-migration-fixtures-${Date.now()}`);
    await mkdir(join(tmpDir, "cases", "multi-source"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads all SQL files in sorted order inside one transaction", async () => {
    await writeFile(join(tmpDir, "cases", "multi-source", "marketplace.sql"), "SELECT 3;");
    await writeFile(join(tmpDir, "cases", "multi-source", "booking.sql"), "SELECT 1;");
    await writeFile(join(tmpDir, "cases", "multi-source", "pms.sql"), "SELECT 2;");
    await writeFile(join(tmpDir, "cases", "multi-source", "manifest.json"), "{}");

    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
      },
    };

    await loadFixtureCase(
      {
        fixtureCase: "multi-source",
        fixturesDir: tmpDir,
      },
      client as never,
    );

    expect(queries).toEqual(["BEGIN", "SELECT 1;", "SELECT 3;", "SELECT 2;", "COMMIT"]);
  });

  it("rolls back when a source fixture fails", async () => {
    await writeFile(join(tmpDir, "cases", "multi-source", "booking.sql"), "SELECT 1;");
    await writeFile(join(tmpDir, "cases", "multi-source", "pms.sql"), "SELECT 2;");

    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql === "SELECT 2;") {
          throw new Error("fixture failed");
        }
      },
    };

    await expect(
      loadFixtureCase(
        {
          fixtureCase: "multi-source",
          fixturesDir: tmpDir,
        },
        client as never,
      ),
    ).rejects.toThrow("fixture failed");

    expect(queries).toEqual(["BEGIN", "SELECT 1;", "SELECT 2;", "ROLLBACK"]);
  });
});
