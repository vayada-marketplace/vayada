import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export type FixtureLoaderConfig = {
  fixtureCase: string;
  fixturesDir: string;
};

/** Loads a fixture case's auth.sql into the target database on an existing connection. */
export async function loadFixtureCase(
  config: FixtureLoaderConfig,
  client: pg.Client,
): Promise<void> {
  const sqlPath = join(config.fixturesDir, "cases", config.fixtureCase, "auth.sql");
  const sql = await readFile(sqlPath, "utf8");
  await client.query(sql);
}
