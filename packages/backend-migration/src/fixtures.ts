import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export type FixtureLoaderConfig = {
  fixtureCase: string;
  fixturesDir: string;
};

function assertSafeFixtureCase(fixtureCase: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(fixtureCase)) {
    throw new Error(
      `Unsafe fixture case name "${fixtureCase}" — must contain only letters, digits, and hyphens.`,
    );
  }
}

/** Loads a fixture case's auth.sql into the target database on an existing connection.
 *  Wraps the entire file in a transaction so a mid-file failure does not leave partial data. */
export async function loadFixtureCase(
  config: FixtureLoaderConfig,
  client: pg.Client,
): Promise<void> {
  assertSafeFixtureCase(config.fixtureCase);
  const caseDir = join(config.fixturesDir, "cases", config.fixtureCase);
  const sqlFiles = (await readdir(caseDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (sqlFiles.length === 0) {
    throw new Error(`Fixture case "${config.fixtureCase}" does not contain any .sql files.`);
  }

  await client.query("BEGIN");
  try {
    for (const filename of sqlFiles) {
      const sql = await readFile(join(caseDir, filename), "utf8");
      await client.query(sql);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
