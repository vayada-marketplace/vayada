import type pg from "pg";

import { backfillCanonicalPropertyResourceLinks } from "./canonicalPropertyLinks.js";
import { getTransformHandler } from "./cases/registry.js";

export type TransformConfig = {
  fixtureCase: string;
};

export async function transformFixtureCase(
  config: TransformConfig,
  client: pg.Client,
): Promise<void> {
  const transform = getTransformHandler(config.fixtureCase);
  if (!transform) return;

  await client.query("BEGIN");
  try {
    await transform(client);
    await backfillCanonicalPropertyResourceLinks(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
