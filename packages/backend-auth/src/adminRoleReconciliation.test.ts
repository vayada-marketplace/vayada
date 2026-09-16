import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { reconcileNextAdminRole } from "./adminRoleReconciliation.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("administrator role reconciliation", () => {
  let pool: pg.Pool, jobId: string, memberId: string, orgId: string, userId: string;
  const updateRole = vi.fn();
  const run = () => reconcileNextAdminRole(pool, { updateRole });
  beforeAll(() => {
    if (new URL(url!).pathname !== "/vay1439_role_worker_test")
      throw new Error("Dedicated worker database required");
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    updateRole.mockReset().mockResolvedValue("updated");
    jobId = randomUUID();
    memberId = randomUUID();
    orgId = randomUUID();
    userId = randomUUID();
    await pool.query("DELETE FROM platform.jobs WHERE queue_name='identity-admin-transfer'");
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug,workos_org_id) VALUES($1,'hotel_group','Role fixture',$1::uuid::text,$1::uuid::text)",
      [orgId],
    );
    await pool.query(
      "INSERT INTO identity.users(id,email) VALUES($1,$1::uuid::text||'@example.test')",
      [userId],
    );
    await pool.query(
      "INSERT INTO identity.external_identities(user_id,provider,provider_user_id) VALUES($1,'workos',$1::uuid::text)",
      [userId],
    );
    await pool.query(
      "INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin,workos_membership_id) VALUES($1,$2,$3,'front_desk','all','agency',$1::uuid::text)",
      [memberId, orgId, userId],
    );
    await pool.query(
      `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,organization_id,resource_product,resource_type,resource_id,payload)
    VALUES($1,$1::uuid::text,'identity-admin-transfer','identity.membership_role.reconcile','organization',$2,'identity','organization_membership',$3,'{"roleSlug":"hotel_owner"}')`,
      [jobId, orgId, memberId],
    );
  });
  const job = async () =>
    (
      await pool.query(
        "SELECT status,attempts_count,locked_by,job_metadata FROM platform.jobs WHERE id=$1",
        [jobId],
      )
    ).rows[0];
  it("ignores stale role payloads and lets only one competing worker call the provider", async () => {
    await Promise.all([run(), run()]);
    expect(updateRole).toHaveBeenCalledTimes(1);
    expect(updateRole).toHaveBeenCalledWith({
      membershipId: memberId,
      organizationId: orgId,
      userId,
      roleSlug: "hotel_member",
    });
    expect(await job()).toMatchObject({ status: "succeeded", attempts_count: 1, locked_by: null });
  });
  it("retries with the latest canonical role and records only sanitized failure codes", async () => {
    updateRole.mockRejectedValueOnce(new Error("private-provider-token"));
    await run();
    expect(await job()).toMatchObject({ status: "pending", attempts_count: 1 });
    expect(JSON.stringify(await job())).not.toContain("private-provider-token");
    await pool.query(
      "UPDATE identity.organization_memberships SET role_key='hotel_manager' WHERE id=$1",
      [memberId],
    );
    await pool.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [jobId]);
    await run();
    expect(updateRole.mock.lastCall?.[0].roleSlug).toBe("hotel_admin");
    expect((await job()).status).toBe("succeeded");
  });
  it("reconciles suspended members/users/organizations before reactivation", async () => {
    await pool.query("UPDATE identity.users SET status='suspended' WHERE id=$1", [userId]);
    await pool.query(
      "UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1",
      [memberId],
    );
    await pool.query("UPDATE identity.organizations SET status='suspended' WHERE id=$1", [orgId]);
    await run();
    expect(updateRole.mock.lastCall?.[0].roleSlug).toBe("hotel_member");
    expect((await job()).status).toBe("succeeded");
    expect(
      (
        await pool.query("SELECT status FROM identity.organization_memberships WHERE id=$1", [
          memberId,
        ])
      ).rows[0].status,
    ).toBe("suspended");
    await pool.query("UPDATE identity.organization_memberships SET status='active' WHERE id=$1", [
      memberId,
    ]);
    await run();
    expect(updateRole).toHaveBeenCalledTimes(1);
  });
  it("cancels removed memberships without a provider call", async () => {
    await pool.query("UPDATE identity.organization_memberships SET status='inactive' WHERE id=$1", [
      memberId,
    ]);
    await run();
    expect(updateRole).not.toHaveBeenCalled();
    expect((await job()).status).toBe("canceled");
  });
  it("dead-letters exhausted or mismatched bindings", async () => {
    updateRole.mockResolvedValueOnce("binding_mismatch");
    await run();
    expect((await job()).status).toBe("dead_lettered");
    await pool.query(
      "UPDATE platform.jobs SET status='pending',finished_at=NULL,run_after=now(),attempts_count=0,max_attempts=1 WHERE id=$1",
      [jobId],
    );
    updateRole.mockRejectedValueOnce(new Error("unavailable"));
    await run();
    expect((await job()).status).toBe("dead_lettered");
  });
  it("recovers expired worker leases and maps canonical owners explicitly", async () => {
    await pool.query(
      "UPDATE identity.organization_memberships SET role_key='hotel_owner' WHERE id=$1",
      [memberId],
    );
    await pool.query(
      "UPDATE platform.jobs SET status='running',locked_at=now()-interval '6 minutes',locked_by='old',attempts_count=1 WHERE id=$1",
      [jobId],
    );
    await run();
    expect(updateRole.mock.lastCall?.[0].roleSlug).toBe("hotel_owner");
    expect((await job()).attempts_count).toBe(2);
  });
});
