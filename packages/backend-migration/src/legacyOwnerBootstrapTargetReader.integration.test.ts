import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { readLegacyOwnerBootstrapTargets } from "./legacyOwnerBootstrapTargetReader.js";
const url = process.env["VAY2017_TARGET_READER_TEST_DATABASE_URL"];
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const owners = Array.from({ length: 8 }, (_, i) => ({
  ownerId: id(i + 1),
  email: `owner${i + 1}@example.invalid`,
}));
describe.skipIf(!url)("target reader on fresh migrated PostgreSQL", () => {
  let client: pg.Client;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_target_reader_fixture" ||
      parsed.search
    )
      throw Error("Dedicated loopback fixture only");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const migrated = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(migrated.failed).toBeNull();
    expect(migrated.applied).toContain("0192");
    // 1 absent, 2 pending exact, 3 ID/email mismatch, 4 different-ID email,
    // 5 suspended, 6 foreign provider-email mapping, 7 duplicate provider links, 8 active.
    for (const [n, email, status] of [
      [2, "owner2", "pending"],
      [3, "different", "active"],
      [44, "owner4", "active"],
      [5, "owner5", "suspended"],
      [6, "owner6", "active"],
      [7, "owner7", "active"],
      [8, "owner8", "active"],
      [99, "unrelated", "active"],
    ] as const)
      await client.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,$3)", [
        id(n),
        "\t" + email + "@example.invalid\n",
        status,
      ]);
    await client.query(
      `INSERT INTO identity.external_identities(user_id,provider,provider_user_id,provider_email)
      VALUES($1,'workos','user_other',$3),($2,'workos','user_seven_a',NULL),($2,'workos','user_seven_b',NULL)`,
      [id(99), id(7), "\u00a0owner6@example.invalid\ufeff"],
    );
  }, 120000);
  afterAll(async () => {
    await client?.query("ROLLBACK");
    await client?.end();
  });
  it("classifies only the eight owners without writes or contact output", async () => {
    await client.query("BEGIN READ ONLY");
    try {
      const before = (
        await client.query(
          "SELECT jsonb_agg(to_jsonb(u) ORDER BY id) AS rows FROM identity.users u",
        )
      ).rows;
      const result = await readLegacyOwnerBootstrapTargets(client, owners);
      expect(result.map((row) => row.target)).toEqual([
        "absent",
        "exact",
        "conflict",
        "conflict",
        "restricted",
        "conflict",
        "conflict",
        "exact",
      ]);
      expect(result.map((row) => row.ownerId)).toEqual(owners.map((owner) => owner.ownerId));
      expect(JSON.stringify(result)).not.toContain("@");
      expect(
        (
          await client.query(
            "SELECT jsonb_agg(to_jsonb(u) ORDER BY id) AS rows FROM identity.users u",
          )
        ).rows,
      ).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("refuses the same data in a writable session", async () => {
    await expect(readLegacyOwnerBootstrapTargets(client, owners)).rejects.toThrow(
      "OWNER_TARGET_READ_FAILED",
    );
  });
  it("rejects non-ASCII email casing instead of relying on database collation", async () => {
    await client.query("BEGIN READ ONLY");
    try {
      const input = structuredClone(owners);
      input[0]!.email = "\u0130@example.invalid";
      await expect(readLegacyOwnerBootstrapTargets(client, input)).rejects.toThrow(
        "INVALID_OWNER_TARGET_SCOPE",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("treats case and outer whitespace consistently", async () => {
    await client.query("BEGIN READ ONLY");
    try {
      expect(
        await readLegacyOwnerBootstrapTargets(
          client,
          owners.map((owner) => ({ ...owner, email: " " + owner.email.toUpperCase() + " " })),
        ),
      ).toEqual(await readLegacyOwnerBootstrapTargets(client, owners));
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
