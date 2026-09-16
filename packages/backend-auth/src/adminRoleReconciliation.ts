import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
export type AdminRoleProvider = {
  updateRole(input: {
    membershipId: string;
    organizationId: string;
    userId: string;
    roleSlug: "hotel_owner" | "hotel_admin" | "hotel_member";
  }): Promise<"updated" | "absent" | "binding_mismatch">;
};
const queue = "identity-admin-transfer",
  type = "identity.membership_role.reconcile";

/** Claim one durable job. No role is trusted from a queued payload. Provider calls must be bounded. */
export async function reconcileNextAdminRole(
  pool: Pool,
  provider: AdminRoleProvider,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      id: string;
      organization_id: string;
      resource_id: string;
      attempts_count: number;
      max_attempts: number;
    }>(
      `
      SELECT id,organization_id,resource_id,attempts_count,max_attempts FROM platform.jobs
      WHERE queue_name=$1 AND job_type=$2 AND ((status='pending' AND run_after<=clock_timestamp())
        OR (status='running' AND locked_at<clock_timestamp()-interval '5 minutes'))
      ORDER BY run_after,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [queue, type],
    );
    const job = selected.rows[0];
    if (!job) {
      await client.query("COMMIT");
      return false;
    }
    if (job.attempts_count >= job.max_attempts) {
      await client.query(
        "UPDATE platform.jobs SET status='dead_lettered',finished_at=clock_timestamp(),locked_by=NULL,locked_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [job.id],
      );
      await client.query("COMMIT");
      return true;
    }
    const lease = randomUUID();
    await client.query(
      "UPDATE platform.jobs SET status='running',attempts_count=attempts_count+1,locked_by=$2,locked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
      [job.id, lease],
    );
    await client.query("COMMIT");
    await client.query("BEGIN");
    const owned = await client.query(
      "SELECT id FROM platform.jobs WHERE id=$1 AND status='running' AND locked_by=$2 FOR UPDATE",
      [job.id, lease],
    );
    if (!owned.rowCount) {
      await client.query("ROLLBACK");
      return true;
    }
    let status = "succeeded",
      failureCode: string | null = null;
    const organization = await client.query(
      "SELECT workos_org_id,status,kind FROM identity.organizations WHERE id=$1 FOR UPDATE",
      [job.organization_id],
    );
    const org = organization.rows[0];
    if (!org || !["active", "suspended"].includes(org.status) || org.kind !== "hotel_group")
      status = "canceled";
    else if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        job.resource_id,
      )
    ) {
      status = "dead_lettered";
      failureCode = "invalid_membership_id";
    } else {
      const members = await client.query<{
        status: string;
        user_status: string;
        role_key: string;
        workos_membership_id: string | null;
        user_id: string;
      }>(
        `
        SELECT m.status,u.status AS user_status,m.role_key,m.workos_membership_id,m.user_id
        FROM identity.organization_memberships m JOIN identity.users u ON u.id=m.user_id
        WHERE m.id=$1 AND m.organization_id=$2 FOR SHARE OF m,u`,
        [job.resource_id, job.organization_id],
      );
      const member = members.rows[0];
      if (
        !member ||
        !["active", "suspended"].includes(member.status) ||
        !["active", "suspended"].includes(member.user_status)
      )
        status = "canceled";
      else {
        const identities = await client.query<{ provider_user_id: string }>(
          "SELECT provider_user_id FROM identity.external_identities WHERE user_id=$1 AND provider='workos' FOR SHARE",
          [member.user_id],
        );
        const roleSlug =
          member.role_key === "hotel_owner"
            ? "hotel_owner"
            : member.role_key === "hotel_manager"
              ? "hotel_admin"
              : ["front_desk", "housekeeping", "hotel_custom", "external_owner"].includes(
                    member.role_key,
                  )
                ? "hotel_member"
                : null;
        if (!roleSlug) {
          status = "dead_lettered";
          failureCode = "unsupported_role";
        } else if (
          !member.workos_membership_id ||
          !org.workos_org_id ||
          identities.rowCount !== 1
        ) {
          status = "pending";
          failureCode = "missing_provider_binding";
        } else {
          try {
            const outcome = await provider.updateRole({
              membershipId: member.workos_membership_id,
              organizationId: org.workos_org_id,
              userId: identities.rows[0]!.provider_user_id,
              roleSlug,
            });
            if (outcome === "absent") status = "canceled";
            else if (outcome === "binding_mismatch") {
              status = "dead_lettered";
              failureCode = "provider_binding_mismatch";
            }
          } catch {
            status = "pending";
            failureCode = "provider_unavailable";
          }
        }
      }
    }
    if (status === "pending" && job.attempts_count + 1 >= job.max_attempts)
      status = "dead_lettered";
    await client.query(
      `UPDATE platform.jobs SET status=$3,locked_at=NULL,locked_by=NULL,
      run_after=CASE WHEN $3='pending' THEN clock_timestamp()+interval '30 seconds' ELSE run_after END,
      finished_at=CASE WHEN $3='pending' THEN NULL ELSE clock_timestamp() END,
      job_metadata=job_metadata||jsonb_build_object('failureCode',$4::text),updated_at=clock_timestamp()
      WHERE id=$1 AND locked_by=$2`,
      [job.id, lease, status, failureCode],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
