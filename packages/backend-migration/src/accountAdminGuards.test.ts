import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("account-admin database guards", () => {
  let client: pg.Client;
  const peers: pg.Client[] = [];
  const org = randomUUID(),
    owner = randomUUID(),
    worker = randomUUID();
  beforeAll(async () => {
    if (new URL(url!).pathname !== "/vay1439_admin_guard_test")
      throw new Error("Requires dedicated admin guard test database");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS identity CASCADE; CREATE SCHEMA identity;
      CREATE TABLE identity.organizations (id uuid PRIMARY KEY, kind text NOT NULL, updated_at timestamptz DEFAULT now());
      CREATE TABLE identity.organization_memberships (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES identity.organizations ON DELETE CASCADE, role_key text NOT NULL, status text NOT NULL);`);
    await client.query(
      await readFile(
        new URL("../migrations/0205_account_admin_guards.sql", import.meta.url),
        "utf8",
      ),
    );
  });
  beforeEach(async () => {
    await client.query("TRUNCATE identity.organizations CASCADE");
    await client.query("INSERT INTO identity.organizations (id, kind) VALUES ($1, 'hotel_group')", [
      org,
    ]);
    await client.query(
      "INSERT INTO identity.organization_memberships VALUES ($1, $3, 'hotel_owner', 'active'), ($2, $3, 'front_desk', 'active')",
      [owner, worker, org],
    );
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    for (const peer of peers.splice(0)) {
      await peer.query("ROLLBACK");
      await peer.end();
    }
  });
  afterAll(async () => {
    await client?.end();
  });
  const enroll = () =>
    client.query("INSERT INTO identity.account_admin_guards (organization_id) VALUES ($1)", [org]);
  it("leaves unenrolled exceptional accounts untouched and rejects their enrollment", async () => {
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'operator' WHERE id = $1",
      [worker],
    );
    await expect(enroll()).rejects.toMatchObject({ code: "23514" });
    expect((await client.query("SELECT * FROM identity.account_admin_guards")).rowCount).toBe(0);
    expect((await client.query("SELECT * FROM identity.organization_memberships")).rowCount).toBe(
      2,
    );
  });
  it("allows an atomic swap but rejects a second owner and removal of the sole owner", async () => {
    await enroll();
    await expect(
      client.query(
        "UPDATE identity.organization_memberships SET role_key = 'hotel_owner' WHERE id = $1",
        [worker],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("DELETE FROM identity.organization_memberships WHERE id = $1", [owner]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("BEGIN");
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'front_desk' WHERE id = $1",
      [owner],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'hotel_owner' WHERE id = $1",
      [worker],
    );
    await client.query("COMMIT");
    expect(
      (
        await client.query(
          "SELECT id FROM identity.organization_memberships WHERE role_key = 'hotel_owner'",
        )
      ).rows,
    ).toEqual([{ id: worker }]);
  });
  it("allows revocation without losing ownership and protects immutable enrollment", async () => {
    await enroll();
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'inactive' WHERE id = $1",
      [owner],
    );
    await expect(client.query("DELETE FROM identity.account_admin_guards")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      client.query("UPDATE identity.account_admin_guards SET organization_id = organization_id"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("UPDATE identity.organizations SET kind = 'creator_workspace' WHERE id = $1", [
        org,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("DELETE FROM identity.organizations WHERE id = $1", [org]);
    expect((await client.query("SELECT * FROM identity.account_admin_guards")).rowCount).toBe(0);
  });
  it("does not block provider revocation behind an organization-first staff command", async () => {
    await enroll();
    const peer = new pg.Client({ connectionString: url });
    peers.push(peer);
    await peer.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM identity.organizations WHERE id = $1 FOR UPDATE", [org]);
    await peer.query("SET statement_timeout = '1s'");
    await peer.query(
      "UPDATE identity.organization_memberships SET status = 'inactive' WHERE id = $1",
      [owner],
    );
    const actor = await client.query(
      "SELECT status FROM identity.organization_memberships WHERE id = $1 FOR UPDATE",
      [owner],
    );
    expect(actor.rows[0].status).toBe("inactive");
    await client.query("COMMIT");
  });
  it.each(["READ COMMITTED", "REPEATABLE READ"])(
    "serializes enrollment against owner writes under %s",
    async (isolation) => {
      const peer = new pg.Client({ connectionString: url });
      peers.push(peer);
      await peer.connect();
      await peer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await peer.query("SELECT * FROM identity.organizations"); // pin the old RR snapshot
      await client.query("BEGIN");
      await enroll();
      const competing = (async () => {
        try {
          await peer.query(
            "UPDATE identity.organization_memberships SET role_key = 'hotel_owner' WHERE id = $1",
            [worker],
          );
          await peer.query("COMMIT");
          return "committed";
        } catch (error) {
          return (error as { code: string }).code;
        }
      })();
      await client.query("COMMIT");
      expect(await competing).toBe(isolation === "READ COMMITTED" ? "23514" : "40001");
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM identity.organization_memberships WHERE role_key = 'hotel_owner'",
          )
        ).rows[0].count,
      ).toBe(1);
    },
  );
});
