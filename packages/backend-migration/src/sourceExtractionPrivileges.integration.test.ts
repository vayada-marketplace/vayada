import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";

import { SOURCE_WRITABLE_PRIVILEGES_SQL } from "./sourceExtraction.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env.TEST_DATABASE_URL;

it.skipIf(!url)("rejects source role membership", async () => {
  assertSafeTestDatabase(url!);
  const suffix = randomUUID().replaceAll("-", "");
  const readerRole = `vay2042_reader_${suffix}`;
  const parentRole = `vay2042_parent_${suffix}`;
  const admin = new pg.Client({ connectionString: url });
  const readerUrl = new URL(url!);
  readerUrl.username = readerRole;
  readerUrl.password = "fixture_only";
  const reader = new pg.Client({ connectionString: readerUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD 'fixture_only' NOINHERIT`);
    await admin.query(`CREATE ROLE ${parentRole} NOLOGIN NOINHERIT`);
    await reader.connect();
    const writable = async () =>
      (await reader.query<{ is_writable: boolean }>(SOURCE_WRITABLE_PRIVILEGES_SQL)).rows[0]
        ?.is_writable;
    expect(await writable()).toBe(false);
    await admin.query(`GRANT ${parentRole} TO ${readerRole} WITH INHERIT FALSE, SET FALSE`);
    expect(await writable()).toBe(true);
  } finally {
    await reader.end().catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${readerRole}, ${parentRole}`);
    await admin.end();
  }
});
