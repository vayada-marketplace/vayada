import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPgIdentityRepository } from "./repository.js";

const databaseUrl = process.env.LEGACY_OWNER_SESSION_TEST_DATABASE_URL;

function assertDisposableSessionDatabase(value: string): void {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["56624", "56625"].includes(url.port) ||
    url.pathname !== "/vay2017_session_test" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("Session integration tests require the dedicated loopback fixture database");
}

describe("session fixture safety", () => {
  it.each([
    "postgres://remote.invalid:56624/vay2017_session_test",
    "postgres://127.0.0.1:56624/production",
    "postgres://127.0.0.1:5432/vay2017_session_test",
    "postgres://127.0.0.1:56624/vay2017_session_test?host=remote.invalid",
  ])("rejects unsafe fixture configuration %s", (value) => {
    expect(() => assertDisposableSessionDatabase(value)).toThrow();
  });
});

// Dedicated disposable local database only. All fixtures, role grants, and
// temporary table renaming are rolled back; no committed receipt is removed.
describe.skipIf(!databaseUrl)("session hold against PostgreSQL", () => {
  let client: pg.Client;
  let lookup: ReturnType<typeof createPgIdentityRepository>["findUserByProviderUserId"];
  const ordinaryId = randomUUID();
  const heldId = randomUUID();
  const role = `session_hold_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    assertDisposableSessionDatabase(databaseUrl!);
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users (id, email, status) VALUES
       ($1, 'ordinary-session@example.invalid', 'active'),
       ($2, 'held-session@example.invalid', 'active')`,
      [ordinaryId, heldId],
    );
    await client.query(
      `INSERT INTO identity.external_identities (user_id, provider, provider_user_id)
       VALUES ($1::uuid, 'workos', $1::uuid::text), ($2::uuid, 'workos', $2::uuid::text)`,
      [ordinaryId, heldId],
    );
    await client.query(
      `INSERT INTO platform.legacy_owner_bootstrap_receipts
       (command_id, contract_version, environment, payload_sha256, owner_user_ids,
        source_run_id, source_evidence_sha256, target_before_sha256, target_after_sha256,
        approval_envelope_sha256, executor_principal_sha256, checkpoint)
       VALUES ($1, 'legacy-owner-internal-setup.v1', 'local', $2, ARRAY[$3]::uuid[],
               $4, $2, $2, $2, $2, $2, 'internal_users_prepared')`,
      [randomUUID(), "a".repeat(64), heldId, `vay1351-${"a".repeat(24)}`],
    );
    await client.query(`CREATE ROLE ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA identity, platform TO ${role}`);
    await client.query(`GRANT SELECT ON identity.users, identity.external_identities TO ${role}`);
    await client.query(
      `GRANT SELECT(owner_user_ids) ON platform.legacy_owner_bootstrap_receipts TO ${role}`,
    );
    // Route the actual repository SQL through the rollback-only fixture client.
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(
      (...args: unknown[]) => client.query(args[0] as string, args[1] as unknown[]) as never,
    );
    lookup = createPgIdentityRepository({
      connectionString: databaseUrl!,
    }).findUserByProviderUserId;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (client) {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("resolves ordinary users and genuine absence using column-only receipt SELECT", async () => {
    await client.query(`SET LOCAL ROLE ${role}`);
    try {
      await expect(lookup("workos", ordinaryId)).resolves.toMatchObject({
        userId: ordinaryId,
        status: "active",
      });
      await expect(lookup("workos", randomUUID())).resolves.toBeNull();
    } finally {
      await client.query("RESET ROLE");
    }
  });

  it.each(["active", "pending"])(
    "denies protected %s users using column-only SELECT",
    async (status) => {
      await client.query("UPDATE identity.users SET status = $1 WHERE id = $2", [status, heldId]);
      await client.query(`SET LOCAL ROLE ${role}`);
      try {
        await expect(lookup("workos", heldId)).rejects.toMatchObject({
          code: "USER_RECONCILIATION_REQUIRED",
        });
      } finally {
        await client.query("RESET ROLE");
      }
    },
  );

  it("sanitizes missing receipt privileges without returning null", async () => {
    await client.query("SAVEPOINT missing_privilege");
    try {
      await client.query(
        `REVOKE SELECT(owner_user_ids) ON platform.legacy_owner_bootstrap_receipts FROM ${role}`,
      );
      await client.query(`SET LOCAL ROLE ${role}`);
      await expect(lookup("workos", ordinaryId)).rejects.toThrow(
        "Identity session evidence unavailable",
      );
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT missing_privilege");
    }
  });

  it("sanitizes missing receipt storage even for an absent identity", async () => {
    await client.query("SAVEPOINT missing_storage");
    try {
      await client.query(
        "ALTER TABLE platform.legacy_owner_bootstrap_receipts RENAME TO session_hold_temporarily_hidden_receipts",
      );
      await expect(lookup("workos", randomUUID())).rejects.toThrow(
        "Identity session evidence unavailable",
      );
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT missing_storage");
    }
  });
});
