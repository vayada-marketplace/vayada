import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_pricing_system_republish_test";
const MIGRATION = 506;
const HASH = "a".repeat(64);

// VAY-2304: payment changes re-publish a hotel's last published prices by themselves, as the system.
describe.skipIf(!URL)("pricing-v2 system re-publish 0506", () => {
  it("keeps existing rows as user rows and takes a system revision and declaration copy", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const dir = await mkdtemp(join(tmpdir(), "vayada-2304-system-republish-"));
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

      const userId = randomUUID(),
        propertyId = randomUUID(),
        declarationId = randomUUID();
      await db.query(
        "INSERT INTO identity.users (id, email, status) VALUES ($1::uuid, $1::uuid::text || '@example.invalid', 'active')",
        [userId],
      );
      await db.query(
        "INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $1::uuid::text, 'Republish test')",
        [propertyId],
      );
      await db.query("INSERT INTO pms.pricing_v2_heads (property_id, revision) VALUES ($1, 1)", [
        propertyId,
      ]);
      const revision = (
        values: { revision: number; actor: string | null; requestId: string },
        extra = "",
        more: unknown[] = [],
      ) =>
        db.query(
          `INSERT INTO pms.pricing_v2_revisions (property_id, revision, room_count, currency, source_revisions,
             owner_references, request_id, request_hash, actor_user_id${extra ? `, ${extra}` : ""})
           VALUES ($1, $2, 1, 'EUR', '{}', '{}', $3, $4, $5${more.map((_, i) => `, $${i + 6}`).join("")})`,
          [propertyId, values.revision, values.requestId, HASH, values.actor, ...more],
        );
      const declaration = (
        id: string,
        values: { actor: string | null; draft: string | null; draftRevision: number | null },
        extra = "",
        more: unknown[] = [],
      ) =>
        db.query(
          `INSERT INTO pms.pricing_v2_charge_declarations (id, property_id, fingerprint, declaration, draft_id,
             draft_revision, request_id, request_hash, actor_user_id${extra ? `, ${extra}` : ""})
           VALUES ($1, $2, $3, 'all_mandatory_charges_included', $4, $5, $6, $3, $7${more
             .map((_, i) => `, $${i + 8}`)
             .join("")})`,
          [
            id,
            propertyId,
            HASH,
            values.draft,
            values.draftRevision,
            randomUUID(),
            values.actor,
            ...more,
          ],
        );
      // Rows saved before 0506: a hotel user's revision and declaration.
      await revision({ revision: 1, actor: userId, requestId: "hotel-save-1" });
      await declaration(declarationId, { actor: userId, draft: randomUUID(), draftRevision: 1 });

      await cp(join(MIGRATIONS, file), join(dir, file));
      const result = await run();
      expect(result.failed).toBeNull();
      expect(result.applied.some((name) => name.includes("0506"))).toBe(true);

      expect(
        (
          await db.query(
            "SELECT actor_type, actor_user_id::text, republished_from FROM pms.pricing_v2_revisions WHERE property_id = $1",
            [propertyId],
          )
        ).rows,
      ).toEqual([{ actor_type: "user", actor_user_id: userId, republished_from: null }]);
      expect(
        (
          await db.query(
            "SELECT actor_type, carried_from FROM pms.pricing_v2_charge_declarations WHERE id = $1",
            [declarationId],
          )
        ).rows,
      ).toEqual([{ actor_type: "user", carried_from: null }]);

      // A system revision copies an earlier one and has no user.
      await revision(
        { revision: 2, actor: null, requestId: "system-1" },
        "actor_type, republished_from",
        ["system", 1],
      );
      await declaration(
        randomUUID(),
        { actor: null, draft: null, draftRevision: null },
        "actor_type, carried_from",
        ["system", declarationId],
      );

      const refused = async (work: () => Promise<unknown>, code: string) => {
        await db.query("SAVEPOINT refused");
        await expect(work()).rejects.toMatchObject({ code });
        await db.query("ROLLBACK TO SAVEPOINT refused");
      };
      await db.query("BEGIN");
      // A user row still needs its user; it copies nothing.
      await refused(() => revision({ revision: 3, actor: null, requestId: "r3" }), "23514");
      await refused(
        () => revision({ revision: 3, actor: userId, requestId: "r3" }, "republished_from", [2]),
        "23514",
      );
      // A system row has no user, and copies an earlier revision of the same property.
      await refused(
        () =>
          revision(
            { revision: 3, actor: userId, requestId: "r3" },
            "actor_type, republished_from",
            ["system", 2],
          ),
        "23514",
      );
      await refused(
        () => revision({ revision: 3, actor: null, requestId: "r3" }, "actor_type", ["system"]),
        "23514",
      );
      await refused(
        () =>
          revision({ revision: 3, actor: null, requestId: "r3" }, "actor_type, republished_from", [
            "system",
            3,
          ]),
        "23514",
      );
      await refused(
        () =>
          revision({ revision: 4, actor: null, requestId: "r4" }, "actor_type, republished_from", [
            "system",
            3,
          ]),
        "23503",
      );
      await refused(
        () => revision({ revision: 3, actor: userId, requestId: "r3" }, "actor_type", ["robot"]),
        "23514",
      );
      // A user declaration still needs its user and draft; a system copy names the one it carries.
      await refused(
        () => declaration(randomUUID(), { actor: userId, draft: null, draftRevision: 1 }),
        "23514",
      );
      await refused(
        () =>
          declaration(
            randomUUID(),
            { actor: null, draft: null, draftRevision: null },
            "actor_type",
            ["system"],
          ),
        "23514",
      );
      await refused(
        () =>
          declaration(
            randomUUID(),
            { actor: userId, draft: null, draftRevision: null },
            "actor_type, carried_from",
            ["system", declarationId],
          ),
        "23514",
      );
      await refused(
        () =>
          declaration(
            randomUUID(),
            { actor: null, draft: null, draftRevision: null },
            "actor_type, carried_from",
            ["system", randomUUID()],
          ),
        "23503",
      );
      await db.query("ROLLBACK");
    } finally {
      await target?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
