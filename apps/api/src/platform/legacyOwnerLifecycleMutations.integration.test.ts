import { randomUUID } from "node:crypto";
import type { IdentityLifecycleCommandBusCommand } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgIdentityLifecycleCommandBus } from "./identityLifecycle.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const hash = "a".repeat(64);
const roleName = `vay2017_lifecycle_reader_${randomUUID().replaceAll("-", "")}`;
const rolePassword = "reader_test_only";

describe.skipIf(!databaseUrl)("prepared-owner lifecycle mutations in PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  let readerUrl: string;
  let lifecycle: ReturnType<typeof createPgIdentityLifecycleCommandBus>;
  let protectedUserId: string;
  let ordinaryUserId: string;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (parsed.hostname !== "localhost" || parsed.pathname !== "/vayada_api_test" || parsed.search)
      throw new Error("Dedicated local API integration database required");
    await admin.connect();
    await admin.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA identity, platform TO ${roleName}`);
    await admin.query(`GRANT SELECT, UPDATE ON identity.users TO ${roleName}`);
    await admin.query(`GRANT SELECT, UPDATE ON identity.external_identities TO ${roleName}`);
    await admin.query(
      `GRANT SELECT (owner_user_ids) ON platform.legacy_owner_bootstrap_receipts TO ${roleName}`,
    );

    protectedUserId = randomUUID();
    ordinaryUserId = randomUUID();
    await admin.query(
      `INSERT INTO identity.users(id, email, status)
       VALUES ($1, $2, 'pending'), ($3, $4, 'pending')`,
      [
        protectedUserId,
        `protected-${protectedUserId}@example.test`,
        ordinaryUserId,
        `ordinary-${ordinaryUserId}@example.test`,
      ],
    );
    await admin.query(
      `INSERT INTO identity.external_identities(user_id, provider, provider_user_id, provider_email)
       VALUES ($1, 'workos', $2, $3), ($4, 'workos', $5, $6)`,
      [
        protectedUserId,
        `user_${protectedUserId}`,
        `protected-${protectedUserId}@example.test`,
        ordinaryUserId,
        `user_${ordinaryUserId}`,
        `ordinary-${ordinaryUserId}@example.test`,
      ],
    );
    await admin.query(
      `INSERT INTO platform.legacy_owner_bootstrap_receipts
       (command_id, contract_version, environment, payload_sha256, owner_user_ids,
        source_run_id, source_evidence_sha256, target_before_sha256, target_after_sha256,
        approval_envelope_sha256, executor_principal_sha256, checkpoint)
       VALUES ($1, 'legacy-owner-internal-setup.v1', 'local', $2, $3,
        'vay1351-aaaaaaaaaaaaaaaaaaaaaaaa', $2, $2, $2, $2, $2, 'internal_users_prepared')`,
      [randomUUID(), hash, [protectedUserId]],
    );

    parsed.username = roleName;
    parsed.password = rolePassword;
    readerUrl = parsed.toString();
    lifecycle = createPgIdentityLifecycleCommandBus({ connectionString: readerUrl, max: 1 });
  });

  afterAll(async () => {
    await lifecycle?.close();
    await admin.query(
      `REVOKE SELECT (owner_user_ids) ON platform.legacy_owner_bootstrap_receipts FROM ${roleName}`,
    );
    await admin.query(`REVOKE SELECT, UPDATE ON identity.external_identities FROM ${roleName}`);
    await admin.query(`REVOKE SELECT, UPDATE ON identity.users FROM ${roleName}`);
    await admin.query(`REVOKE USAGE ON SCHEMA identity, platform FROM ${roleName}`);
    await admin.query(`DROP ROLE ${roleName}`);
    await admin.end();
  });

  function emailCommand(userId: string, email: string): IdentityLifecycleCommandBusCommand {
    return {
      commandType: "identity.user.email.update",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      audit: {
        actor: { kind: "system", service: "test" },
        source: "web",
        requestId: randomUUID(),
        reason: "Synthetic PostgreSQL lifecycle guard test",
        requestedAt: new Date().toISOString(),
      },
      payload: { userId, email, providerEmailVerified: true },
    };
  }

  it("denies protected email updates while allowing the restrictive status transition", async () => {
    await expect(
      lifecycle.execute(emailCommand(protectedUserId, "blocked@example.test")),
    ).rejects.toThrow("Legacy owner account reconciliation required");
    await expect(
      lifecycle.execute({
        ...emailCommand(protectedUserId, "unused@example.test"),
        commandType: "identity.user.status.update",
        payload: { userId: protectedUserId, status: "suspended" },
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(
      (
        await admin.query("SELECT email, status FROM identity.users WHERE id = $1", [
          protectedUserId,
        ])
      ).rows,
    ).toEqual([{ email: `protected-${protectedUserId}@example.test`, status: "suspended" }]);
  });

  it("allows ordinary email updates and keeps receipt columns private", async () => {
    await expect(
      lifecycle.execute(emailCommand(ordinaryUserId, "ordinary-updated@example.test")),
    ).resolves.toMatchObject({ status: "accepted" });
    const reader = new pg.Client({ connectionString: readerUrl });
    await reader.connect();
    try {
      await expect(
        reader.query("SELECT payload_sha256 FROM platform.legacy_owner_bootstrap_receipts"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await reader.end();
    }
  });
});
