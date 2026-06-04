import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export type FixtureLoaderConfig = {
  fixtureCase: string;
  fixturesDir: string;
};

/** Loads a fixture case's auth.sql into the target database on an existing connection.
 *  Wraps the entire file in a transaction so a mid-file failure does not leave partial data. */
export async function loadFixtureCase(
  config: FixtureLoaderConfig,
  client: pg.Client,
): Promise<void> {
  const sqlPath = join(config.fixturesDir, "cases", config.fixtureCase, "auth.sql");
  const sql = await readFile(sqlPath, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
