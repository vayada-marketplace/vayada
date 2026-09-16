import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { runAdminTransfer } from "./accountAdminTransferCommand.js";
import { lockAdminTransferSnapshot } from "./accountAdminTransferSnapshot.js";
import {
  createAdminTransferProof,
  verifyAdminTransferProof,
} from "./accountAdminTransferProofs.js";
import {
  validateAdminTransferRequest,
  type AdminTransferRequest,
} from "./accountAdminTransferValidation.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("atomic administrator transfer", () => {
  let pool: pg.Pool;
  let source: Parameters<typeof runAdminTransfer>[1];
  let request: AdminTransferRequest;
  let proofId: string;
  beforeAll(() => {
    if (new URL(url!).pathname !== "/vay1439_transfer_command_test")
      throw new Error("Dedicated command database required");
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    source = {
      organizationId: randomUUID(),
      actorMembershipId: randomUUID(),
      actorUserId: randomUUID(),
      workosUserId: randomUUID(),
      workosOrgId: randomUUID(),
      sessionId: randomUUID(),
    };
    const target = randomUUID(),
      targetUser = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO identity.organizations(id,kind,name,slug,workos_org_id) VALUES($1,'hotel_group','Transfer fixture',$1::uuid::text,$2)",
        [source.organizationId, source.workosOrgId],
      );
      await client.query(
        "INSERT INTO identity.users(id,email) VALUES($1,$1::uuid::text||'@example.test'),($2,$2::uuid::text||'@example.test')",
        [source.actorUserId, targetUser],
      );
      await client.query(
        "INSERT INTO identity.external_identities(user_id,provider,provider_user_id) VALUES($1,'workos',$2)",
        [source.actorUserId, source.workosUserId],
      );
      await client.query(
        `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin,pms_access_enabled,booking_access_enabled)
        VALUES($1,$2,$3,'hotel_owner','all','agency',true,true),($4,$2,$5,'front_desk','assigned','agency',false,false)`,
        [source.actorMembershipId, source.organizationId, source.actorUserId, target, targetUser],
      );
      const role = (
        await client.query(
          "SELECT id FROM identity.organization_roles WHERE organization_id=$1 AND preset_key='front_desk'",
          [source.organizationId],
        )
      ).rows[0].id;
      await prepareProof(client, target, role);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  async function prepareProof(client: pg.PoolClient, target: string, role: string) {
    const snapshot = (await lockAdminTransferSnapshot(client, {
      ...source,
      targetMembershipId: target,
      formerAdminRoleId: role,
    }))!;
    request = {
      targetMembershipId: target,
      expectedActorRevision: snapshot.actor.revision,
      expectedTargetRevision: snapshot.target.revision,
      formerAdmin: {
        roleDefinitionId: role,
        expectedRoleRevision: snapshot.formerAdminRole.revision,
        propertyAccessMode: "all",
        propertyIds: [],
        permissionOverrides: { grant: [], deny: [] },
        productAccess: { pms: false, booking: true },
      },
    };
    const valid = validateAdminTransferRequest(request, {
      ...source,
      actorRevision: snapshot.actor.revision,
      targetMembershipId: target,
      targetRevision: snapshot.target.revision,
      role: snapshot.formerAdminRole,
      propertyIds: [],
    });
    if (!valid.ok) throw new Error(valid.error);
    const binding = { ...source, targetMembershipId: target, requestDigest: valid.requestDigest };
    const proof = await createAdminTransferProof(client, binding);
    proofId = proof.id;
    expect(
      await verifyAdminTransferProof(
        client,
        binding,
        proof.state,
        "local-test-token",
        async () => ({
          workosUserId: source.workosUserId,
          workosOrgId: source.workosOrgId,
          sessionId: "fresh",
          authenticatedAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        }),
      ),
    ).toBe(proofId);
  }
  async function rows() {
    return (
      await pool.query(
        "SELECT id,role_key,property_access_mode,access_origin,pms_access_enabled,booking_access_enabled,permission_overrides FROM identity.organization_memberships WHERE organization_id=$1 ORDER BY role_key",
        [source.organizationId],
      )
    ).rows;
  }
  it("atomically normalizes the new admin and applies explicit former-admin access", async () => {
    expect(await runAdminTransfer(pool, source, request, proofId.toUpperCase())).toEqual({
      outcome: "transferred",
    });
    expect(await runAdminTransfer(pool, source, request, proofId)).toEqual({
      outcome: "idempotent_replay",
    });
    expect(await rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: request.targetMembershipId,
          role_key: "hotel_owner",
          property_access_mode: "all",
          access_origin: "agency",
          pms_access_enabled: true,
          booking_access_enabled: true,
          permission_overrides: { grant: [], deny: [] },
        }),
        expect.objectContaining({
          id: source.actorMembershipId,
          role_key: "front_desk",
          pms_access_enabled: false,
          booking_access_enabled: true,
        }),
      ]),
    );
    expect(
      (
        await pool.query("SELECT id FROM platform.jobs WHERE organization_id=$1", [
          source.organizationId,
        ])
      ).rowCount,
    ).toBe(4);
  });
  it("serializes duplicate transfers and returns a bound receipt without repeating effects", async () => {
    const results = await Promise.all([
      runAdminTransfer(pool, source, request, proofId.toUpperCase()),
      runAdminTransfer(pool, source, request, proofId),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["idempotent_replay", "transferred"]);
    expect(
      (
        await pool.query("SELECT id FROM platform.product_audit_events WHERE organization_id=$1", [
          source.organizationId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await runAdminTransfer(pool, { ...source, sessionId: "different" }, request, proofId))
        .outcome,
    ).toBe("rejected");
  });
  it("rejects stale access without consuming proof or changing ownership", async () => {
    await pool.query(
      "UPDATE identity.organization_memberships SET booking_access_enabled=true WHERE id=$1",
      [request.targetMembershipId],
    );
    expect(await runAdminTransfer(pool, source, request, proofId)).toEqual({
      outcome: "rejected",
      reason: "stale_transfer",
    });
    expect(
      (
        await pool.query(
          "SELECT consumed_at FROM identity.account_admin_transfer_proofs WHERE id=$1",
          [proofId],
        )
      ).rows[0].consumed_at,
    ).toBeNull();
    expect((await rows()).find((r) => r.id === source.actorMembershipId).role_key).toBe(
      "hotel_owner",
    );
  });
  it("rejects an unbound session without changing ownership or consuming proof", async () => {
    expect(
      await runAdminTransfer(pool, { ...source, sessionId: "wrong" }, request, proofId),
    ).toEqual({ outcome: "rejected", reason: "invalid_proof" });
    expect((await rows()).find((r) => r.id === source.actorMembershipId).role_key).toBe(
      "hotel_owner",
    );
    expect(
      (
        await pool.query(
          "SELECT consumed_at FROM identity.account_admin_transfer_proofs WHERE id=$1",
          [proofId],
        )
      ).rows[0].consumed_at,
    ).toBeNull();
  });
  it("rechecks the access revision after waiting behind a compatible access write", async () => {
    const peer = await pool.connect();
    try {
      await peer.query("BEGIN");
      await peer.query("SELECT id FROM identity.organizations WHERE id=$1 FOR UPDATE", [
        source.organizationId,
      ]);
      await peer.query(
        "UPDATE identity.organization_memberships SET booking_access_enabled=true WHERE id=$1",
        [request.targetMembershipId],
      );
      let finished = false;
      const pending = runAdminTransfer(pool, source, request, proofId).then((result) => {
        finished = true;
        return result;
      });
      await peer.query("SELECT pg_sleep(0.05)");
      expect(finished).toBe(false);
      await peer.query("COMMIT");
      expect(await pending).toEqual({ outcome: "rejected", reason: "stale_transfer" });
    } finally {
      await peer.query("ROLLBACK");
      peer.release();
    }
  });
  it("adopts delegated staff without retaining its delegation", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const owner = randomUUID(),
        user = randomUUID();
      await client.query(
        "INSERT INTO identity.users(id,email) VALUES($1,$1::uuid::text||'@example.test')",
        [user],
      );
      await client.query(
        "INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin) VALUES($1,$2,$3,'external_owner','assigned','agency')",
        [owner, source.organizationId, user],
      );
      await client.query(
        "UPDATE identity.organization_memberships SET access_origin='external_owner' WHERE id=$1",
        [request.targetMembershipId],
      );
      await client.query(
        "INSERT INTO identity.membership_delegations(organization_id,subject_membership_id,delegator_membership_id,created_by_membership_id) VALUES($1,$2,$3,$4)",
        [source.organizationId, request.targetMembershipId, owner, source.actorMembershipId],
      );
      await prepareProof(client, request.targetMembershipId, request.formerAdmin.roleDefinitionId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect((await runAdminTransfer(pool, source, request, proofId)).outcome).toBe("transferred");
    expect(
      (
        await pool.query(
          "SELECT subject_membership_id FROM identity.membership_delegations WHERE subject_membership_id=$1",
          [request.targetMembershipId],
        )
      ).rowCount,
    ).toBe(0);
    expect((await rows()).find((r) => r.id === request.targetMembershipId).access_origin).toBe(
      "agency",
    );
  });
  it("rolls back ownership, proof, enrollment and jobs when audit fails", async () => {
    await pool.query(`CREATE FUNCTION platform.reject_transfer_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$;
      CREATE TRIGGER reject_transfer_fixture BEFORE INSERT ON platform.product_audit_events FOR EACH ROW EXECUTE FUNCTION platform.reject_transfer_fixture()`);
    try {
      await expect(runAdminTransfer(pool, source, request, proofId)).rejects.toThrow(
        "injected audit failure",
      );
      expect((await rows()).find((r) => r.id === source.actorMembershipId).role_key).toBe(
        "hotel_owner",
      );
      expect(
        (
          await pool.query(
            "SELECT consumed_at FROM identity.account_admin_transfer_proofs WHERE id=$1",
            [proofId],
          )
        ).rows[0].consumed_at,
      ).toBeNull();
      for (const table of ["platform.jobs", "identity.account_admin_guards"])
        expect(
          (
            await pool.query(`SELECT organization_id FROM ${table} WHERE organization_id=$1`, [
              source.organizationId,
            ])
          ).rowCount,
        ).toBe(0);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_transfer_fixture ON platform.product_audit_events; DROP FUNCTION platform.reject_transfer_fixture()",
      );
    }
  });
});
