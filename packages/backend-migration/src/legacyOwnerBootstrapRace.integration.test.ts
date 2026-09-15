import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexPlan.js";
import { runMigrations } from "./runner.js";

const url = process.env["VAY2017_BOOTSTRAP_RACE_TEST_DATABASE_URL"];
const emails = Array.from({ length: 8 }, (_, i) => `race${i}@example.invalid`);
const hashes = emails.map((email) => createHash("sha256").update(email).digest("hex"));

function assertFixture(value: string): void {
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname !== "127.0.0.1" ||
    !["56624", "56625"].includes(parsed.port) ||
    parsed.pathname !== "/vay2017_bootstrap_race_test" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Dedicated loopback bootstrap race fixture required");
}

describe("bootstrap race fixture safety", () => {
  it.each([
    "postgres://remote.invalid:56624/vay2017_bootstrap_race_test",
    "postgres://127.0.0.1:5432/vay2017_bootstrap_race_test",
    "postgres://127.0.0.1:56624/production",
    "postgres://127.0.0.1:56624/vay2017_bootstrap_race_test?host=remote.invalid",
  ])("rejects %s", (value) => expect(() => assertFixture(value)).toThrow());
});

// Storage-contract fixtures, NOT the future approved executor or signup API.
// No provider calls, ownership eligibility, signatures or account linking.
describe.skipIf(!url)("atomic bootstrap versus ordinary insert", () => {
  let observer: pg.Client;
  beforeAll(async () => {
    assertFixture(url!);
    observer = new pg.Client({ connectionString: url });
    await observer.connect();
    expect((await observer.query("SHOW server_encoding")).rows[0].server_encoding).toBe("UTF8");
    expect(
      (await observer.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    await observer.query(planLegacyOwnerEmailIndex(hashes).sql);
  }, 120_000);
  afterAll(async () => {
    await observer?.end();
  });

  async function receipt(client: pg.Client, owner: string, command: string, valid = true) {
    await client.query(
      `INSERT INTO platform.legacy_owner_bootstrap_receipts
       (command_id, contract_version, environment, payload_sha256, owner_user_ids,
        source_run_id, source_evidence_sha256, target_before_sha256, target_after_sha256,
        approval_envelope_sha256, executor_principal_sha256, checkpoint)
       VALUES ($1, 'legacy-owner-internal-setup.v1', 'local', $2, ARRAY[$3]::uuid[],
               $4, $5, $5, $5, $5, $5, 'internal_users_prepared')`,
      [
        command,
        valid ? "a".repeat(64) : "invalid",
        owner,
        `vay1351-${"a".repeat(24)}`,
        "a".repeat(64),
      ],
    );
  }

  it.each(["bootstrap commits", "signup commits", "bootstrap receipt fails"] as const)(
    "%s while the competing insert waits",
    async (scenario) => {
      const index = ["bootstrap commits", "signup commits", "bootstrap receipt fails"].indexOf(
        scenario,
      );
      const owner = randomUUID();
      const signup = randomUUID();
      const command = randomUUID();
      const first = new pg.Client({ connectionString: url });
      const second = new pg.Client({ connectionString: url });
      const connected: pg.Client[] = [];
      // Attach rejection handling immediately: a failed assertion must not leave
      // an unhandled blocked-query rejection during cleanup.
      let pending: Promise<{ code: string | null }> | undefined;
      try {
        await first.connect();
        connected.push(first);
        await second.connect();
        connected.push(second);
        await first.query("BEGIN");
        await second.query("BEGIN");
        await second.query("SET LOCAL statement_timeout = '5s'");
        const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const signupFirst = scenario === "signup commits";
        await first.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,$3)", [
          signupFirst ? signup : owner,
          emails[index],
          signupFirst ? "active" : "pending",
        ]);
        if (scenario === "bootstrap commits") await receipt(first, owner, command);
        pending = second
          .query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,$3)", [
            signupFirst ? owner : signup,
            `\u00a0${emails[index]!.toUpperCase()}\ufeff`,
            signupFirst ? "pending" : "active",
          ])
          .then(
            () => ({ code: null }),
            (error: { code: string }) => ({ code: error.code }),
          );

        await expect
          .poll(
            async () => {
              const result = await observer.query(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [firstPid, secondPid],
              );
              return result.rows[0].blocked;
            },
            { timeout: 2_000 },
          )
          .toBe(true);
        expect(
          (
            await observer.query("SELECT id FROM identity.users WHERE id=ANY($1::uuid[])", [
              [owner, signup],
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (
            await observer.query(
              "SELECT command_id FROM platform.legacy_owner_bootstrap_receipts WHERE command_id=$1",
              [command],
            )
          ).rows,
        ).toEqual([]);

        if (scenario === "bootstrap receipt fails") {
          await expect(receipt(first, owner, command, false)).rejects.toMatchObject({
            code: "23514",
          });
          await first.query("ROLLBACK");
          expect(await pending).toEqual({ code: null });
          await second.query("COMMIT");
        } else {
          await first.query("COMMIT");
          expect(await pending).toEqual({ code: "23505" });
          await second.query("ROLLBACK");
        }
        const prepared = scenario === "bootstrap commits";
        expect(
          (
            await observer.query("SELECT id,status FROM identity.users WHERE id=ANY($1::uuid[])", [
              [owner, signup],
            ])
          ).rows,
        ).toEqual([{ id: prepared ? owner : signup, status: prepared ? "pending" : "active" }]);
        expect(
          (
            await observer.query(
              "SELECT owner_user_ids FROM platform.legacy_owner_bootstrap_receipts WHERE command_id=$1",
              [command],
            )
          ).rows,
        ).toEqual(prepared ? [{ owner_user_ids: [owner] }] : []);
        expect(
          (
            await observer.query(
              "SELECT 1 FROM identity.organization_memberships WHERE user_id=ANY($1::uuid[])",
              [[owner, signup]],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        // Always close both sockets, even if connect or rollback failed. Start
        // both rollbacks together so the first releases the competing insert.
        try {
          await Promise.allSettled(connected.map((client) => client.query("ROLLBACK")));
          await pending;
        } finally {
          await Promise.allSettled([first.end(), second.end()]);
        }
      }
    },
    15_000,
  );
});
