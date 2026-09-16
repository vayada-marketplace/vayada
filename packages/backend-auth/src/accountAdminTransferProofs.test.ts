import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAdminTransferProof,
  verifyAdminTransferProof,
  consumeAdminTransferProof,
  type AdminTransferBinding,
} from "./accountAdminTransferProofs.js";
import type { VerifiedSession } from "./verify.js";

const url = process.env["TEST_DATABASE_URL"];
const org = "14390000-0000-4000-8000-000000000001";
const actor = "14390000-0000-4000-8000-000000000002";
const target = "14390000-0000-4000-8000-000000000003";
const binding: AdminTransferBinding = {
  organizationId: org,
  actorMembershipId: actor,
  targetMembershipId: target,
  workosUserId: "user_actor",
  workosOrgId: "org_workos",
  sessionId: "source_session",
  requestDigest: "a".repeat(64),
};
const session = (): VerifiedSession => ({
  workosUserId: binding.workosUserId,
  workosOrgId: binding.workosOrgId,
  sessionId: "reauth_session",
  authenticatedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});

describe.skipIf(!url)("single-use admin transfer proof", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  beforeAll(async () => {
    if (new URL(url!).pathname !== "/vay1439_transfer_proof_test")
      throw new Error("Dedicated proof database required");
    pool = new pg.Pool({ connectionString: url });
    client = await pool.connect();
    await client.query(`DROP SCHEMA IF EXISTS identity CASCADE; CREATE SCHEMA identity;
      CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
      CREATE TABLE identity.organization_memberships (id UUID PRIMARY KEY, organization_id UUID);
      INSERT INTO identity.organizations VALUES ('${org}');
      INSERT INTO identity.organization_memberships VALUES ('${actor}', '${org}'), ('${target}', '${org}');`);
    await client.query(
      await readFile(
        new URL(
          "../../backend-migration/migrations/0206_account_admin_transfer_proofs.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });
  beforeEach(async () => {
    await client.query("TRUNCATE identity.account_admin_transfer_proofs");
  });
  afterAll(async () => {
    client?.release();
    await pool?.end();
  });
  const verify = (state: string, b = binding, s = session()) =>
    verifyAdminTransferProof(client, b, state, "server-exchanged-token", async () => s);

  it("stores only hashed state and requires provider evidence before consumption", async () => {
    const proof = await createAdminTransferProof(client, binding);
    const row = (await client.query("SELECT * FROM identity.account_admin_transfer_proofs"))
      .rows[0];
    expect(row.state_digest).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(proof.state);
    expect(await consumeAdminTransferProof(client, binding, proof.id)).toBe(false);
    expect(await verify(proof.state)).toBe(proof.id);
    expect(await verify(proof.state)).toBeNull();
    expect(await consumeAdminTransferProof(client, binding, proof.id)).toBe(true);
    expect(await consumeAdminTransferProof(client, binding, proof.id)).toBe(false);
  });

  it("rejects stale, absent, future, expired, wrong-user, and wrong-organization evidence", async () => {
    const proof = await createAdminTransferProof(client, binding);
    for (const patch of [
      { authenticatedAt: undefined },
      { authenticatedAt: 1 },
      { authenticatedAt: Math.floor(Date.now() / 1000) + 60 },
      { expiresAt: 1 },
      { workosUserId: "different" },
      { workosOrgId: "different" },
      { sessionId: null },
    ]) {
      expect(await verify(proof.state, binding, { ...session(), ...patch })).toBeNull();
    }
    await expect(
      verifyAdminTransferProof(client, binding, proof.state, "forged", async () => {
        throw new Error("bad signature");
      }),
    ).rejects.toThrow("bad signature");
    expect(await verify(proof.state)).toBe(proof.id);
  });

  it("rejects changes to every binding at verification and consumption", async () => {
    const proof = await createAdminTransferProof(client, binding);
    const patches = [
      { organizationId: target },
      { actorMembershipId: target },
      { targetMembershipId: actor },
      { workosUserId: "other" },
      { workosOrgId: "other" },
      { sessionId: "other" },
      { requestDigest: "b".repeat(64) },
    ];
    for (const patch of patches)
      expect(await verify(proof.state, { ...binding, ...patch })).toBeNull();
    expect(await verify("wrong-state")).toBeNull();
    expect(await verify(proof.state)).toBe(proof.id);
    for (const patch of patches)
      expect(await consumeAdminTransferProof(client, { ...binding, ...patch }, proof.id)).toBe(
        false,
      );
    expect(await consumeAdminTransferProof(client, binding, proof.id)).toBe(true);
  });

  it("restores consumption on rollback and serializes competing transfers", async () => {
    const proof = await createAdminTransferProof(client, binding);
    await verify(proof.state);
    await client.query("BEGIN");
    expect(await consumeAdminTransferProof(client, binding, proof.id)).toBe(true);
    await client.query("ROLLBACK");
    const peer = await pool.connect();
    try {
      const results = await Promise.all([
        consumeAdminTransferProof(client, binding, proof.id),
        consumeAdminTransferProof(peer, binding, proof.id),
      ]);
      expect(results.sort()).toEqual([false, true]);
    } finally {
      peer.release();
    }
  });

  it.each(["verify", "consume"])(
    "rechecks expiry after a row-lock wait during %s",
    async (action) => {
      const proof = await createAdminTransferProof(client, binding);
      if (action === "consume") await verify(proof.state);
      const peer = await pool.connect();
      try {
        await client.query(
          "UPDATE identity.account_admin_transfer_proofs SET expires_at = clock_timestamp() + interval '250 milliseconds'",
        );
        await client.query("BEGIN");
        await client.query("SELECT id FROM identity.account_admin_transfer_proofs FOR UPDATE");
        const pending =
          action === "consume"
            ? consumeAdminTransferProof(peer, binding, proof.id)
            : verifyAdminTransferProof(peer, binding, proof.state, "exchanged", async () =>
                session(),
              );
        await client.query("SELECT pg_sleep(0.4)");
        await client.query("COMMIT");
        expect(await pending).toBe(action === "consume" ? false : null);
      } finally {
        await client.query("ROLLBACK");
        peer.release();
      }
    },
  );

  it("rejects expired challenges and proofs", async () => {
    const proof = await createAdminTransferProof(client, binding);
    await client.query(
      "UPDATE identity.account_admin_transfer_proofs SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute'",
    );
    expect(await verify(proof.state)).toBeNull();
    const fresh = await createAdminTransferProof(client, binding);
    await verify(fresh.state);
    await client.query(
      "UPDATE identity.account_admin_transfer_proofs SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute'",
    );
    expect(await consumeAdminTransferProof(client, binding, fresh.id)).toBe(false);
  });
});
