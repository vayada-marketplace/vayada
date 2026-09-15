import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPgTeamRoleRepository } from "./teamRoles.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("organization role catalog", () => {
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
