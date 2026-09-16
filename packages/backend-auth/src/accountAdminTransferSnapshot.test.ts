import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockAdminTransferSnapshot } from "./accountAdminTransferSnapshot.js";
const url = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `14390000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const input = {
  organizationId: id(1),
  actorMembershipId: id(2),
  actorUserId: id(3),
  workosUserId: "transfer_snapshot_actor",
  workosOrgId: "transfer_snapshot_org",
  targetMembershipId: id(4),
  formerAdminRoleId: "",
};
describe.skipIf(!url)("locked admin transfer snapshot", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  beforeAll(async () => {
    if (new URL(url!).pathname !== "/vay1439_restack_test")
      throw new Error("Dedicated test database required");
    pool = new pg.Pool({ connectionString: url });
    client = await pool.connect();
  });
  afterAll(async () => {
    client?.release();
    await pool?.end();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.organizations(id, kind, name, slug, workos_org_id)
      VALUES ($1, 'hotel_group', 'Snapshot fixture', 'transfer-snapshot-fixture', $2)`,
      [id(1), input.workosOrgId],
    );
    await client.query(
      `INSERT INTO identity.users(id, email) VALUES ($1, 'snapshot-actor@example.test'), ($2, 'snapshot-target@example.test')`,
      [id(3), id(5)],
    );
    await client.query(
      `INSERT INTO identity.external_identities(user_id, provider, provider_user_id) VALUES ($1, 'workos', $2)`,
      [id(3), input.workosUserId],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships(id, organization_id, user_id, role_key, property_access_mode, access_origin)
      VALUES ($1, $2, $3, 'hotel_owner', 'all', 'agency'), ($4, $2, $5, 'front_desk', 'assigned', 'agency')`,
      [id(2), id(1), id(3), id(4), id(5)],
    );
    input.formerAdminRoleId = (
      await client.query(
        "SELECT id FROM identity.organization_roles WHERE organization_id=$1 AND preset_key='front_desk'",
        [id(1)],
      )
    ).rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });
  it("loads canonical ownership and detects access revision changes", async () => {
    const first = await lockAdminTransferSnapshot(client, input);
    expect(first?.actor.id).toBe(id(2));
    expect(first?.target.id).toBe(id(4));
    expect(first?.formerAdminRole.id).toBe(input.formerAdminRoleId);
    await client.query(
      "UPDATE identity.organization_memberships SET booking_access_enabled=false WHERE id=$1",
      [id(4)],
    );
    const next = await lockAdminTransferSnapshot(client, input);
    expect(next?.target.revision).not.toBe(first?.target.revision);
    expect(next?.actor.revision).toBe(first?.actor.revision);
  });
  it("rejects mismatched actor/provider/organization bindings and suspended users", async () => {
    for (const patch of [
      { actorUserId: id(5) },
      { workosUserId: "wrong" },
      { workosOrgId: "wrong" },
      { targetMembershipId: id(2) },
    ])
      expect(await lockAdminTransferSnapshot(client, { ...input, ...patch })).toBeNull();
    await client.query("UPDATE identity.users SET status='suspended' WHERE id=$1", [id(5)]);
    expect(await lockAdminTransferSnapshot(client, input)).toBeNull();
  });
  it("rejects inactive historical owners and restricted current admins", async () => {
    await client.query(
      "UPDATE identity.organization_memberships SET pms_access_enabled=false WHERE id=$1",
      [id(2)],
    );
    expect(await lockAdminTransferSnapshot(client, input)).toBeNull();
    await client.query(
      "UPDATE identity.organization_memberships SET pms_access_enabled=true WHERE id=$1",
      [id(2)],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET role_key='hotel_owner', status='inactive', property_access_mode='all' WHERE id=$1",
      [id(4)],
    );
    expect(await lockAdminTransferSnapshot(client, input)).toBeNull();
  });
  it("rejects a delegator with dependents but permits delegated staff adoption", async () => {
    await client.query(
      "INSERT INTO identity.users(id,email) VALUES ($1,'snapshot-owner@example.test')",
      [id(7)],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin)
      VALUES ($1,$2,$3,'external_owner','assigned','agency')`,
      [id(6), id(1), id(7)],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET access_origin='external_owner' WHERE id=$1",
      [id(4)],
    );
    await client.query(
      `INSERT INTO identity.membership_delegations(organization_id,subject_membership_id,delegator_membership_id,created_by_membership_id)
      VALUES ($1,$2,$3,$4)`,
      [id(1), id(4), id(6), id(2)],
    );
    expect(
      await lockAdminTransferSnapshot(client, { ...input, targetMembershipId: id(6) }),
    ).toBeNull();
    expect((await lockAdminTransferSnapshot(client, input))?.target.access_origin).toBe(
      "external_owner",
    );
  });
});
