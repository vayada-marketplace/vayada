import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { verifyLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexVerification.js";
import {
  OWNER_EMAIL_INDEX_EXPRESSION as expression,
  planLegacyOwnerEmailIndex as plan,
} from "./legacyOwnerEmailIndexPlan.js";

const emails = Array.from({ length: 8 }, (_, n) => `guard${n}@example.invalid`);
const hashes = emails.map((email) => createHash("sha256").update(email).digest("hex"));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe("owner email index proposal", () => {
  it("is deterministic, hashed-only and non-executable", () => {
    const before = [...hashes];
    const result = plan(hashes);
    expect(result).toEqual(plan([...hashes].reverse()));
    expect(hashes).toEqual(before);
    expect(result.executable).toBe(false);
    expect(result.indexName.length).toBeLessThan(64);
    expect(emails.some((email) => result.sql.includes(email))).toBe(false);
  });
  it("rejects incomplete, duplicate or injected scope", () => {
    const sparse = [...hashes];
    delete sparse[0];
    for (const invalid of [
      sparse,
      hashes.slice(1),
      [...hashes, hashes[0]!],
      [...hashes.slice(1), hashes[1]!],
      ["';DROP TABLE identity.users;--", ...hashes.slice(1)],
    ])
      expect(() => plan(invalid)).toThrow("INVALID_OWNER_EMAIL_GUARD_SCOPE");
  });
});
const url = process.env["VAY2017_EMAIL_GUARD_TEST_DATABASE_URL"];
describe.skipIf(!url)("scoped uniqueness on a fresh local PostgreSQL database", () => {
  let client: pg.Client;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_email_guard_fixture" ||
      parsed.search
    )
      throw new Error("Dedicated loopback email guard fixture required");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    expect((await client.query("SHOW server_encoding")).rows[0].server_encoding).toBe("UTF8");
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    await client.query(plan(hashes).sql);
  }, 120_000);
  afterAll(async () => {
    await client?.end();
  });
  it("matches UTF8 byte hashing for Unicode, quotes, whitespace and backslashes", async () => {
    for (const email of [
      "simple@example.invalid",
      "\\\\test\\123@example.invalid",
      "O'Reilly@example.invalid",
      "\u00a0MiXeD@example.invalid\ufeff",
      "\u0130\u212a\u00df@example.invalid",
      "漢字@example.invalid",
    ]) {
      const row = (
        await client.query(
          `SELECT ${expression} AS actual,
        encode(sha256(convert_to(lower(btrim(email,U&'\\0009\\000a\\000b\\000c\\000d\\0020\\00a0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200a\\2028\\2029\\202f\\205f\\3000\\feff')),'UTF8')),'hex') AS expected
        FROM (VALUES($1::text)) v(email)`,
          [email],
        )
      ).rows[0];
      expect(row.actual).toBe(row.expected);
    }
  });
  it("arbitrates concurrent unmodified inserts for a protected email", async () => {
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      const results = await Promise.allSettled([
        client.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'pending')", [
          id(1),
          emails[0],
        ]),
        other.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
          id(2),
          `\u00a0${emails[0]!.toUpperCase()}\ufeff`,
        ]),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code,
      ).toBe("23505");
    } finally {
      await other.end();
    }
  });
  it("preserves duplicate behavior outside the cohort and guards email updates", async () => {
    await client.query(
      "INSERT INTO identity.users(id,email) VALUES($1,'outside@example.invalid'),($2,'outside@example.invalid')",
      [id(3), id(4)],
    );
    await expect(
      client.query("UPDATE identity.users SET email=$1 WHERE id=$2", [emails[0], id(3)]),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM identity.users WHERE email='outside@example.invalid'",
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("rejects construction over preexisting duplicates without changing rows", async () => {
    const outside = createHash("sha256").update("outside@example.invalid").digest("hex");
    await expect(client.query(plan([outside, ...hashes.slice(1)]).sql)).rejects.toMatchObject({
      code: "23505",
    });
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM identity.users WHERE email='outside@example.invalid'",
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("verifies the exact installed guard in a read-only transaction", async () => {
    await client.query("BEGIN READ ONLY");
    try {
      await client.query("SET LOCAL search_path = pg_catalog");
      await expect(verifyLegacyOwnerEmailIndex(client, hashes)).resolves.toEqual({
        indexName: plan(hashes).indexName,
        scopeSha256: plan(hashes).scopeSha256,
        executable: false,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it.each([
    "missing",
    "nonunique",
    "expression",
    "predicate",
    "wrong table",
    "include",
    "collation",
    "column collation",
  ])("rejects an altered installed guard: %s", async (variant) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL search_path = pg_catalog");
      const proposal = plan(hashes);
      await client.query(`DROP INDEX identity.${proposal.indexName}`);
      let sql = proposal.sql;
      if (variant === "nonunique") sql = sql.replace("CREATE UNIQUE", "CREATE");
      if (variant === "expression") sql = sql.replace(expression, "lower(email)");
      if (variant === "predicate") sql = sql.replace(/WHERE[\s\S]+$/, "WHERE false");
      if (variant === "include") sql = sql.replace("\nWHERE", " INCLUDE (id)\nWHERE");
      if (variant === "collation")
        sql = sql.replace(`((${expression}))`, `((${expression}) COLLATE \"C\")`);
      if (variant === "wrong table") {
        await client.query("CREATE TABLE identity.other_users (email text)");
        sql = sql.replace("ON identity.users", "ON identity.other_users");
      }
      if (variant === "column collation")
        await client.query('ALTER TABLE identity.users ALTER COLUMN email TYPE text COLLATE "C"');
      if (variant !== "missing") await client.query(sql);
      await expect(verifyLegacyOwnerEmailIndex(client, hashes)).rejects.toThrow(
        "LEGACY_OWNER_EMAIL_INDEX_NOT_VERIFIED",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
