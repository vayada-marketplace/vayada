import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPgTeamRoleRepository } from "./teamRoles.js";
import type { TeamRoleCreateCommand } from "./teamRoleCreate.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("organization role catalog", () => {
  it("creates and clones roles only for a live admin, with replay, audit and protected ceilings", async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Refusing non-test database");
    const client = new pg.Client({ connectionString: url });
    const repository = createPgTeamRoleRepository({ connectionString: url! });
    await client.connect();
    const org = randomUUID(),
      user = randomUUID(),
      staffUser = randomUUID(),
      protectedRole = randomUUID();
    const command = (
      payload: Partial<TeamRoleCreateCommand["payload"]> = {},
    ): TeamRoleCreateCommand => ({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      audit: {
        actor: { kind: "user", userId: user, organizationId: org },
        source: "api",
        requestId: randomUUID(),
        reason: "Create test role",
        requestedAt: new Date().toISOString(),
      },
      payload: {
        organizationId: org,
        name: "Custom",
        description: "Team role",
        defaultPermissions: ["pms.calendar.read"],
        ...payload,
      },
    });
    try {
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug) VALUES ($1::uuid, 'hotel_group', 'Role command test', $1::text)`,
        [org],
      );
      await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        user,
        `${user}@example.com`,
      ]);
      await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        staffUser,
        `${staffUser}@example.com`,
      ]);
      await client.query(
        `INSERT INTO identity.organization_memberships (organization_id, user_id, role_key, status, property_access_mode, access_origin) VALUES ($1, $2, 'hotel_owner', 'active', 'all', 'agency')`,
        [org, user],
      );
      const input = command();
      const results = await Promise.all([repository.create(input), repository.create(input)]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "created",
        "idempotent_replay",
      ]);
      expect(results[0]).toHaveProperty("roleId");
      expect(results[0]).toMatchObject({ roleId: (results[1] as { roleId: string }).roleId });
      await expect(
        repository.create({ ...input, payload: { ...input.payload, description: "changed" } }),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "idempotency_conflict" });
      await expect(repository.create(command({ name: "CUSTOM" }))).resolves.toMatchObject({
        outcome: "rejected",
        reason: "name_conflict",
      });
      await expect(
        repository.create(
          command({ name: "Escalated", defaultPermissions: ["identity.staff.manage"] }),
        ),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "invalid_permissions" });
      await expect(
        repository.create(command({ name: "Foreign source", sourceRoleId: randomUUID() })),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "invalid_source_role" });
      const adminRole = randomUUID();
      await client.query(
        `INSERT INTO identity.organization_roles (id, organization_id, name, security_class, base_role_key, preset_key, default_permissions) VALUES ($1, $2, 'Account admin', 'account_admin', 'hotel_owner', 'account_admin', '[]')`,
        [adminRole, org],
      );
      await expect(
        repository.create(
          command({ name: "Admin clone", sourceRoleId: adminRole, defaultPermissions: [] }),
        ),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "invalid_source_role" });
      await client.query(
        `INSERT INTO identity.organization_roles (id, organization_id, name, security_class, base_role_key, preset_key, default_permissions) VALUES ($1, $2, 'Housekeeping', 'housekeeping', 'housekeeping', 'housekeeping', '["pms.calendar.read"]')`,
        [protectedRole, org],
      );
      await expect(
        repository.create(command({ name: "Housekeeping clone", sourceRoleId: protectedRole })),
      ).resolves.toMatchObject({ outcome: "created" });
      const clone = (await repository.list(org)).find((role) => role.name === "Housekeeping clone");
      expect(clone).toMatchObject({
        securityClass: "housekeeping",
        presetKey: null,
        baseRoleKey: "housekeeping",
      });
      const edit = (expectedRevision: string, defaultPermissions: string[]) =>
        repository.change({
          ...command(),
          payload: {
            organizationId: org,
            roleId: clone!.id,
            expectedRevision,
            operation: "update",
            name: "Housekeeping clone",
            description: "Updated",
            defaultPermissions,
          },
        });
      await expect(edit("1", ["pms.calendar.read", "pms.inbox.read"])).resolves.toMatchObject({
        outcome: "updated",
      });
      await client.query(
        `INSERT INTO identity.organization_memberships (organization_id, user_id, role_key, status, property_access_mode, access_origin, role_definition_id, permission_overrides) VALUES ($1, $2, 'housekeeping', 'active', 'all', 'agency', $3, '{"grant":["pms.calendar.manage"],"deny":[]}')`,
        [org, staffUser, clone!.id],
      );
      await expect(edit("2", [])).resolves.toMatchObject({
        outcome: "rejected",
        reason: "invalid_member_overrides",
      });
      expect((await repository.list(org)).find((role) => role.id === clone!.id)!.revision).toBe(
        "2",
      );
      await expect(edit("2", ["pms.calendar.read"])).resolves.toMatchObject({ outcome: "updated" });
      await expect(edit("2", ["pms.calendar.read"])).resolves.toMatchObject({
        outcome: "rejected",
        reason: "stale_revision",
      });
      const deletion = {
        ...command(),
        payload: {
          organizationId: org,
          roleId: clone!.id,
          expectedRevision: "3",
          operation: "delete" as const,
        },
      };
      await client.query(
        `INSERT INTO identity.staff_invitations
        (organization_id, email, inviter_membership_id, inviter_user_id, inviter_name_snapshot, role_key, permission_overrides, property_access_mode, configuration_revision, command_id, idempotency_key_hash, request_fingerprint_hash, request_id, request_source, reason, requested_at, role_definition_id)
        SELECT $1, 'role-mutation-invite@example.com', member.id, member.user_id, 'Test admin', 'housekeeping', '{"grant":["pms.calendar.manage"],"deny":[]}', 'all', 1, $3, $4, $4, $3, 'api', 'Test pending role', now(), $2 FROM identity.organization_memberships member WHERE member.organization_id = $1 AND member.role_key = 'hotel_owner'`,
        [org, clone!.id, randomUUID(), randomBytes(32)],
      );
      await expect(repository.change(deletion)).resolves.toMatchObject({
        outcome: "rejected",
        reason: "role_in_use",
      });
      await client.query(
        `UPDATE identity.organization_memberships SET status = 'inactive' WHERE user_id = $1`,
        [staffUser],
      );
      await expect(repository.change(deletion)).resolves.toMatchObject({
        outcome: "rejected",
        reason: "role_in_use",
      });
      await expect(edit("3", [])).resolves.toMatchObject({
        outcome: "rejected",
        reason: "invalid_member_overrides",
      });
      await client.query(
        `UPDATE identity.staff_invitations SET status = 'revoked' WHERE organization_id = $1`,
        [org],
      );
      await expect(repository.change(deletion)).resolves.toMatchObject({
        outcome: "deleted",
        roleId: clone!.id,
      });
      const historical = await client.query(
        `SELECT role_definition_id FROM identity.staff_invitations WHERE organization_id = $1`,
        [org],
      );
      expect(historical.rows).toEqual([{ role_definition_id: null }]);
      await expect(repository.change(deletion)).resolves.toMatchObject({
        outcome: "idempotent_replay",
        roleId: clone!.id,
      });
      await expect(
        repository.change({
          ...deletion,
          idempotencyKey: randomUUID(),
          payload: { ...deletion.payload, roleId: adminRole, expectedRevision: "1" },
        }),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "invalid_source_role" });
      const jobs = await client.query(
        `SELECT job_metadata FROM platform.jobs WHERE organization_id = $1`,
        [org],
      );
      expect(jobs.rows).toMatchObject([{ job_metadata: { reason: "role_permissions_changed" } }]);
      await expect(
        repository.create(
          command({
            name: "Contacts clone",
            sourceRoleId: protectedRole,
            defaultPermissions: ["pms.guest_contact.read"],
          }),
        ),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "invalid_permissions" });
      await client.query(
        `UPDATE identity.organization_memberships SET role_key = 'hotel_manager' WHERE organization_id = $1`,
        [org],
      );
      await expect(repository.create(command({ name: "Manager attempt" }))).resolves.toMatchObject({
        outcome: "rejected",
        reason: "forbidden",
      });
      await expect(repository.create(input)).resolves.toMatchObject({
        outcome: "rejected",
        reason: "forbidden",
      });
      await client.query(
        `UPDATE identity.organization_memberships SET role_key = 'hotel_owner' WHERE organization_id = $1`,
        [org],
      );
      await client.query(`UPDATE identity.users SET status = 'suspended' WHERE id = $1`, [user]);
      await expect(
        repository.create(command({ name: "Suspended attempt" })),
      ).resolves.toMatchObject({ outcome: "rejected", reason: "forbidden" });
      const audits = await client.query(
        `SELECT action FROM platform.product_audit_events WHERE organization_id = $1`,
        [org],
      );
      expect(audits.rows.map((row) => row.action).sort()).toEqual([
        "identity.team_role.created",
        "identity.team_role.created",
        "identity.team_role.deleted",
        "identity.team_role.updated",
        "identity.team_role.updated",
      ]);
      const keys = await client.query(
        `SELECT status FROM platform.idempotency_keys WHERE organization_id = $1`,
        [org],
      );
      expect(keys.rows).toHaveLength(5);
      expect(keys.rows.every((row) => row.status === "completed")).toBe(true);
    } finally {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`DELETE FROM platform.jobs WHERE organization_id = $1`, [org]);
      await client.query(`DELETE FROM identity.staff_invitations WHERE organization_id = $1`, [
        org,
      ]);
      await client.query(`DELETE FROM platform.product_audit_events WHERE organization_id = $1`, [
        org,
      ]);
      await client.query(`DELETE FROM platform.idempotency_keys WHERE organization_id = $1`, [org]);
      await client.query(
        `DELETE FROM identity.organization_memberships WHERE organization_id = $1`,
        [org],
      );
      await client.query(`DELETE FROM identity.organization_roles WHERE organization_id = $1`, [
        org,
      ]);
      await client.query(`DELETE FROM identity.organizations WHERE id = $1`, [org]);
      await client.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
        [user, staffUser],
      ]);
      await client.query("COMMIT");
      await repository.close();
      await client.end();
    }
  });

  it("isolates organizations, counts live references and rejects invalid stored defaults", async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Refusing non-test database");
    const client = new pg.Client({ connectionString: url });
    const repository = createPgTeamRoleRepository({ connectionString: url! });
    await client.connect();
    const org = randomUUID(),
      other = randomUUID(),
      user = randomUUID(),
      role = randomUUID();
    try {
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug) VALUES ($1::uuid, 'hotel_group', 'Role test', $1::text), ($2::uuid, 'hotel_group', 'Other role test', $2::text)`,
        [org, other],
      );
      await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        user,
        `${user}@example.com`,
      ]);
      await client.query(
        `INSERT INTO identity.organization_roles (id, organization_id, name, security_class, base_role_key, default_permissions) VALUES ($1, $2, 'Custom role', 'staff', 'hotel_custom', '["pms.calendar.read"]')`,
        [role, org],
      );
      await client.query(
        `INSERT INTO identity.organization_memberships (organization_id, user_id, role_key, status, property_access_mode, role_definition_id, access_origin) VALUES ($1, $2, 'hotel_custom', 'active', 'all', $3, 'agency')`,
        [org, user, role],
      );
      await expect(repository.list(other)).resolves.toEqual([]);
      const roles = await repository.list(org);
      expect(roles).toHaveLength(1);
      expect(roles[0]).toMatchObject({
        id: role,
        name: "Custom role",
        revision: "1",
        memberCount: 1,
        invitationCount: 0,
        immutable: false,
        defaultPermissions: ["pms.calendar.read"],
      });
      expect(roles[0]!.allowedPermissions).toContain("pms.calendar.manage");
      expect(roles[0]!.allowedPermissions).not.toContain("identity.staff.manage");
      await client.query(
        `INSERT INTO identity.staff_invitations
         (organization_id, email, inviter_membership_id, inviter_user_id, inviter_name_snapshot,
          role_key, permission_overrides, property_access_mode, configuration_revision, command_id,
          idempotency_key_hash, request_fingerprint_hash, request_id, request_source, reason, requested_at, role_definition_id)
         SELECT $1, 'invited@example.com', member.id, member.user_id, 'Test actor',
           'hotel_custom', '{"grant":[],"deny":[]}', 'all', 1, $3, $4, $4, $3, 'api', 'Test invitation', now(), $2
         FROM identity.organization_memberships member WHERE member.organization_id = $1`,
        [org, role, randomUUID(), randomBytes(32)],
      );
      expect((await repository.list(org))[0]!.invitationCount).toBe(1);
      await client.query(
        `UPDATE identity.staff_invitations SET delivery_state = 'delivered', delivery_attempted_at = now(), provider_invitation_id = $2, expires_at = now() - interval '1 day' WHERE organization_id = $1`,
        [org, randomUUID()],
      );
      expect((await repository.list(org))[0]!.invitationCount).toBe(0);
      await client.query(
        `UPDATE identity.organization_memberships SET status = 'suspended' WHERE organization_id = $1`,
        [org],
      );
      expect((await repository.list(org))[0]!.memberCount).toBe(1);
      await client.query(
        `UPDATE identity.organization_memberships SET status = 'inactive' WHERE organization_id = $1`,
        [org],
      );
      expect((await repository.list(org))[0]!.memberCount).toBe(0);
      await client.query(`UPDATE identity.organizations SET status = 'suspended' WHERE id = $1`, [
        org,
      ]);
      await expect(repository.list(org)).resolves.toEqual([]);
      await client.query(`UPDATE identity.organizations SET status = 'active' WHERE id = $1`, [
        org,
      ]);
      await client.query(
        `UPDATE identity.organization_roles SET default_permissions = '["finance.billing.manage"]' WHERE id = $1`,
        [role],
      );
      await expect(repository.list(org)).rejects.toThrow("Team role configuration is unavailable");
    } finally {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`DELETE FROM identity.staff_invitations WHERE organization_id = $1`, [
        org,
      ]);
      await client.query(
        `DELETE FROM identity.organization_memberships WHERE organization_id = $1`,
        [org],
      );
      await client.query(`DELETE FROM identity.organization_roles WHERE organization_id = $1`, [
        org,
      ]);
      await client.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
        [org, other],
      ]);
      await client.query(`DELETE FROM identity.users WHERE id = $1`, [user]);
      await client.query("COMMIT");
      await repository.close();
      await client.end();
    }
  });
});
