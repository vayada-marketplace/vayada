import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_team_roles_default_set_test";
const MIGRATION = 508;

// VAY-2276: hosts create their own staff roles. New accounts get Account admin, Property owner and
// Agency manager; existing accounts lose the ready-made staff roles that the host never edited and
// nobody uses.
describe.skipIf(!URL)("team roles: default set 0508", () => {
  it("deletes only untouched, unused staff presets and seeds new accounts with the default set", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const dir = await mkdtemp(join(tmpdir(), "vayada-2276-team-roles-"));
    const run = () =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      let file = "";
      for (const name of await readdir(MIGRATIONS)) {
        if (!/^\d{4}_/.test(name)) continue;
        const version = Number(name.slice(0, 4));
        if (version < MIGRATION) await cp(join(MIGRATIONS, name), join(dir, name));
        if (version === MIGRATION) file = name;
      }
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      // Before 0508 the trigger gives each new hotel account all six roles.
      const account = async (kind = "hotel_group") => {
        const id = randomUUID();
        await db.query(
          "INSERT INTO identity.organizations (id, kind, name, slug) VALUES ($1, $2, $3, $3)",
          [id, kind, `org-${id}`],
        );
        return id;
      };
      const member = async (organization: string, roleKey: string, status: string) => {
        const user = randomUUID(),
          id = randomUUID();
        await db.query(
          "INSERT INTO identity.users (id, email) VALUES ($1::uuid, $1::text || '@example.test')",
          [user],
        );
        await db.query(
          `INSERT INTO identity.organization_memberships
             (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
           VALUES ($1, $2, $3, $4, $5, $6, 'agency')`,
          [id, organization, user, status, roleKey, roleKey === "hotel_owner" ? "all" : "assigned"],
        );
        return { id, user };
      };
      const role = async (organization: string, preset: string) =>
        (
          await db.query<{ id: string }>(
            "SELECT id FROM identity.organization_roles WHERE organization_id = $1 AND preset_key = $2",
            [organization, preset],
          )
        ).rows[0]!.id;
      const assign = (membership: string, roleId: string) =>
        db.query(
          "UPDATE identity.organization_memberships SET role_definition_id = $2 WHERE id = $1",
          [membership, roleId],
        );
      const invite = async (
        organization: string,
        inviter: { id: string; user: string },
        roleId: string,
        roleKey: string,
        status: "pending" | "revoked",
        sent?: "expired" | "valid",
      ) => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO identity.staff_invitations
             (id, organization_id, email, inviter_membership_id, inviter_user_id, inviter_name_snapshot, role_key,
              permission_overrides, property_access_mode, status, configuration_revision, command_id,
              idempotency_key_hash, request_fingerprint_hash, provider_invitation_id, expires_at, request_id,
              request_source, reason, requested_at, role_definition_id, delivery_state, delivery_attempted_at)
           VALUES ($1::uuid, $2, $1::text || '@example.test', $3, $4, 'Owner', $5, '{}'::jsonb, 'assigned', $6, 1, $1::text,
             $7, $8, $9, $10, 'request', 'web', 'test', now(), $11,
             CASE WHEN $9::text IS NULL THEN 'ready' ELSE 'delivered' END,
             CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)`,
          [
            id,
            organization,
            inviter.id,
            inviter.user,
            roleKey,
            status,
            randomBytes(32),
            randomBytes(32),
            sent ? `invitation_${id}` : null,
            sent ? new Date(Date.now() + (sent === "expired" ? -1 : 7) * 86_400_000) : null,
            roleId,
          ],
        );
        return id;
      };
      const presets = async (organization: string) =>
        (
          await db.query<{ preset_key: string | null; name: string }>(
            "SELECT preset_key, name FROM identity.organization_roles WHERE organization_id = $1 ORDER BY name",
            [organization],
          )
        ).rows;
      const triggerObjects = async () =>
        (
          await db.query<{ definition: string }>(
            `SELECT pg_get_functiondef('identity.initialize_new_account_team_roles()'::regprocedure) AS definition
             UNION ALL
             SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
             WHERE t.tgrelid = 'identity.organizations'::regclass AND t.tgname = 'initialize_new_account_team_roles'`,
          )
        ).rows;

      // Account A: every ready-made role untouched.
      const a = await account();
      const aOwner = await member(a, "hotel_owner", "active");
      // Agency manager is in the default set: it stays, even with only an inactive member.
      const aInactive = await member(a, "hotel_manager", "inactive");
      const aAgency = await role(a, "agency_manager");
      await assign(aInactive.id, aAgency);
      // Property owner is in the default set: it stays unused.
      // Reservation manager: a pending invitation that is still valid keeps it.
      await invite(a, aOwner, await role(a, "reservation_manager"), "hotel_custom", "pending");
      // Front desk: an active member keeps it.
      await assign((await member(a, "front_desk", "active")).id, await role(a, "front_desk"));
      // Housekeeping: only a pending invitation that ran out, so it goes and the invitation expires.
      const aExpired = await invite(
        a,
        aOwner,
        await role(a, "housekeeping"),
        "housekeeping",
        "pending",
        "expired",
      );

      // Account B: the host renamed Agency manager and made a role of their own.
      const b = await account();
      const bOwner = await member(b, "hotel_owner", "active");
      await db.query(
        "UPDATE identity.organization_roles SET name = 'Our agency' WHERE organization_id = $1 AND preset_key = 'agency_manager'",
        [b],
      );
      await db.query(
        `INSERT INTO identity.organization_roles (organization_id, name, security_class, base_role_key, default_permissions)
         VALUES ($1, 'Night audit', 'staff', 'hotel_custom', '["pms.calendar.read"]'::jsonb)`,
        [b],
      );
      // Front desk: a suspended member still holds it.
      await assign((await member(b, "front_desk", "suspended")).id, await role(b, "front_desk"));
      // Reservation manager: only a revoked invitation, so it goes and the invitation keeps its status.
      const bRevoked = await invite(
        b,
        bOwner,
        await role(b, "reservation_manager"),
        "hotel_custom",
        "revoked",
      );
      // Housekeeping: a sent invitation that is still valid keeps it.
      const bSent = await invite(
        b,
        bOwner,
        await role(b, "housekeeping"),
        "housekeeping",
        "pending",
        "valid",
      );

      // Account C: a pending (not yet joined) member keeps Front desk; Reservation manager has only an
      // inactive member, so it goes and the member loses the link; Housekeeping is unused and goes.
      const c = await account();
      await member(c, "hotel_owner", "active");
      await assign((await member(c, "front_desk", "pending")).id, await role(c, "front_desk"));
      const cInactive = await member(c, "hotel_custom", "inactive");
      await assign(cInactive.id, await role(c, "reservation_manager"));
      const permissions = async (organization: string) =>
        (
          await db.query<{ preset_key: string; default_permissions: string[] }>(
            `SELECT preset_key, default_permissions FROM identity.organization_roles
             WHERE organization_id = $1 AND preset_key IN ('account_admin', 'agency_manager', 'property_owner')
             ORDER BY preset_key`,
            [organization],
          )
        ).rows;
      const presetsBefore = await permissions(a);
      const before = await triggerObjects();

      await cp(join(MIGRATIONS, file), join(dir, file));
      const result = await run();
      expect(result.failed).toBeNull();
      expect(result.applied.some((name) => name.includes("0508"))).toBe(true);

      expect(await presets(a)).toEqual([
        { preset_key: "account_admin", name: "Account admin" },
        { preset_key: "agency_manager", name: "Agency manager" },
        { preset_key: "front_desk", name: "Front desk" },
        { preset_key: "property_owner", name: "Property owner" },
        { preset_key: "reservation_manager", name: "Reservation manager" },
      ]);
      expect(await presets(b)).toEqual([
        { preset_key: "account_admin", name: "Account admin" },
        { preset_key: "front_desk", name: "Front desk" },
        { preset_key: "housekeeping", name: "Housekeeping" },
        { preset_key: null, name: "Night audit" },
        { preset_key: "agency_manager", name: "Our agency" },
        { preset_key: "property_owner", name: "Property owner" },
      ]);
      expect(await presets(c)).toEqual([
        { preset_key: "account_admin", name: "Account admin" },
        { preset_key: "agency_manager", name: "Agency manager" },
        { preset_key: "front_desk", name: "Front desk" },
        { preset_key: "property_owner", name: "Property owner" },
      ]);
      const roleLinks = async (ids: string[]) =>
        (
          await db.query(
            "SELECT id, role_definition_id FROM identity.organization_memberships WHERE id = ANY($1::uuid[]) ORDER BY id",
            [ids],
          )
        ).rows;
      expect(await roleLinks([aInactive.id, cInactive.id])).toEqual(
        [
          { id: aInactive.id, role_definition_id: aAgency },
          { id: cInactive.id, role_definition_id: null },
        ].sort((x, y) => x.id.localeCompare(y.id)),
      );
      expect(
        (
          await db.query(
            "SELECT id, status, role_definition_id FROM identity.staff_invitations WHERE id = ANY($1::uuid[]) ORDER BY status",
            [[aExpired, bRevoked]],
          )
        ).rows,
      ).toEqual([
        { id: aExpired, status: "expired", role_definition_id: null },
        { id: bRevoked, status: "revoked", role_definition_id: null },
      ]);
      expect(
        (await db.query("SELECT status FROM identity.staff_invitations WHERE id = $1", [bSent]))
          .rows,
      ).toEqual([{ status: "pending" }]);

      // One audit event per deleted role, with the row and the links it cleared (for a rollback).
      const audits = async () =>
        (
          await db.query<{
            organization_id: string;
            preset: string;
            memberships: string[];
            invitations: { id: string; status: string }[];
          }>(
            `SELECT organization_id::text, private_payload->'previous'->>'preset_key' AS preset,
               private_payload->'clearedMemberships' AS memberships,
               private_payload->'clearedInvitations' AS invitations
             FROM platform.product_audit_events
             WHERE product = 'identity' AND action = 'identity.team_role.deleted' AND actor_type = 'migration'
               AND audit_key LIKE 'team-role-cleanup-0508:%'
             ORDER BY organization_id, preset`,
          )
        ).rows;
      const events = await audits();
      expect(events).toHaveLength(4);
      const of = (organization: string) =>
        events.filter((event) => event.organization_id === organization);
      expect(of(a)).toEqual([
        {
          organization_id: a,
          preset: "housekeeping",
          memberships: [],
          invitations: [{ id: aExpired, status: "pending" }],
        },
      ]);
      expect(of(b)).toEqual([
        {
          organization_id: b,
          preset: "reservation_manager",
          memberships: [],
          invitations: [{ id: bRevoked, status: "revoked" }],
        },
      ]);
      expect(of(c)).toEqual([
        { organization_id: c, preset: "housekeeping", memberships: [], invitations: [] },
        {
          organization_id: c,
          preset: "reservation_manager",
          memberships: [cInactive.id],
          invitations: [],
        },
      ]);

      // New accounts get the default set, through the same trigger as before, with 0203's exact rows.
      expect(await triggerObjects()).toEqual(before);
      const fresh = await account();
      expect(await presets(fresh)).toEqual([
        { preset_key: "account_admin", name: "Account admin" },
        { preset_key: "agency_manager", name: "Agency manager" },
        { preset_key: "property_owner", name: "Property owner" },
      ]);
      expect(await permissions(fresh)).toEqual(presetsBefore);
      expect(await presets(await account("platform"))).toEqual([]);

      // Running it again deletes nothing more.
      const after = [await presets(a), await presets(b), await presets(c)];
      await db.query("BEGIN");
      await db.query(await readFile(join(MIGRATIONS, file), "utf8"));
      expect([await presets(a), await presets(b), await presets(c)]).toEqual(after);
      expect(await audits()).toHaveLength(4);
      await db.query("ROLLBACK");
    } finally {
      await target?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
