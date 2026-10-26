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
const DATABASE = "vayada_setup_tracks_only_test";
const MIGRATION = 492;

// VAY-2270: the Creator Marketplace setup track is retired; Hotel Operations is the only track.
describe.skipIf(!URL)("setup tracks Hotel Operations only 0492", () => {
  it("keeps Hotel Operations, drops Marketplace-only selections and the retired step", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2270-setup-tracks-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < MIGRATION)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const organization = async (tracks: string[] | null) => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO identity.organizations (id, kind, name, slug) VALUES ($1::uuid, 'hotel_group', 'Track test', $1::text)`,
          [id],
        );
        if (tracks) {
          await db.query(
            `INSERT INTO hotel_catalog.organization_setup_track_intents (organization_id, selected_tracks, revision)
             VALUES ($1::uuid, $2::text[], 3)`,
            [id, tracks],
          );
        }
        return id;
      };
      const session = async (
        organizationId: string,
        tracks: string[],
        resume: string | null,
        completed: string[],
        drafts: string[],
      ) => {
        const property = randomUUID();
        await db.query(
          `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $1::text, 'Track hotel')`,
          [property],
        );
        const result = await db.query<{ id: string }>(
          `INSERT INTO hotel_catalog.property_setup_sessions
             (organization_id, property_id, selected_tracks, track_revision, revision,
              resume_step_id, completed_step_ids, retention_expires_at)
           VALUES ($1::uuid, $2::uuid, $3::text[], 3, 5, $4, $5::text[], now() + interval '30 days')
           RETURNING id::text`,
          [organizationId, property, tracks, resume, completed],
        );
        const id = result.rows[0]!.id;
        for (const step of drafts) {
          await db.query(
            `INSERT INTO hotel_catalog.property_setup_step_drafts (session_id, step_id, retention_expires_at)
             VALUES ($1::uuid, $2, now() + interval '30 days')`,
            [id, step],
          );
        }
        return id;
      };

      const operations = await organization(["hotel_operations"]);
      const both = await organization(["hotel_operations", "creator_marketplace"]);
      const marketplaceOnly = await organization(["creator_marketplace"]);
      const operationsSession = await session(
        operations,
        ["hotel_operations"],
        "rooms",
        ["present_hotel"],
        ["present_hotel", "rooms"],
      );
      const bothSession = await session(
        both,
        ["hotel_operations", "creator_marketplace"],
        "marketplace_preferences",
        ["present_hotel", "marketplace_preferences"],
        ["present_hotel", "marketplace_preferences"],
      );
      const marketplaceSession = await session(
        marketplaceOnly,
        ["creator_marketplace"],
        "marketplace_preferences",
        [],
        ["marketplace_preferences"],
      );

      expect((await run(MIGRATIONS)).failed).toBeNull();

      const intents = await db.query<{
        organizationId: string;
        tracks: string[];
        revision: number;
      }>(
        `SELECT organization_id::text AS "organizationId", selected_tracks AS tracks, revision
         FROM hotel_catalog.organization_setup_track_intents
         WHERE organization_id = ANY($1::uuid[]) ORDER BY organization_id`,
        [[operations, both, marketplaceOnly]],
      );
      expect(Object.fromEntries(intents.rows.map((row) => [row.organizationId, row]))).toEqual({
        [operations]: { organizationId: operations, tracks: ["hotel_operations"], revision: 3 },
        [both]: { organizationId: both, tracks: ["hotel_operations"], revision: 3 },
      });

      const sessions = await db.query<{
        id: string;
        tracks: string[];
        resume: string | null;
        completed: string[];
        revision: number;
      }>(
        `SELECT id::text, selected_tracks AS tracks, resume_step_id AS resume,
                completed_step_ids AS completed, revision
         FROM hotel_catalog.property_setup_sessions WHERE id = ANY($1::uuid[])`,
        [[operationsSession, bothSession, marketplaceSession]],
      );
      expect(Object.fromEntries(sessions.rows.map((row) => [row.id, row]))).toEqual({
        [operationsSession]: {
          id: operationsSession,
          tracks: ["hotel_operations"],
          resume: "rooms",
          completed: ["present_hotel"],
          revision: 5,
        },
        [bothSession]: {
          id: bothSession,
          tracks: ["hotel_operations"],
          resume: null,
          completed: ["present_hotel"],
          revision: 5,
        },
      });
      const drafts = await db.query<{ sessionId: string; stepId: string }>(
        `SELECT session_id::text AS "sessionId", step_id AS "stepId"
         FROM hotel_catalog.property_setup_step_drafts WHERE session_id = ANY($1::uuid[])
         ORDER BY session_id, step_id`,
        [[operationsSession, bothSession, marketplaceSession]],
      );
      expect(drafts.rows).toHaveLength(3);
      expect(drafts.rows.every(({ stepId }) => stepId !== "marketplace_preferences")).toBe(true);

      // The constraints no longer accept the retired track or step.
      await expect(
        db.query(
          `INSERT INTO hotel_catalog.organization_setup_track_intents (organization_id, selected_tracks)
           VALUES ($1::uuid, ARRAY['creator_marketplace']::text[])`,
          [marketplaceOnly],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query(
          `UPDATE hotel_catalog.property_setup_sessions SET resume_step_id = 'marketplace_preferences'
           WHERE id = $1::uuid`,
          [operationsSession],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query(
          `INSERT INTO hotel_catalog.property_setup_step_drafts (session_id, step_id, retention_expires_at)
           VALUES ($1::uuid, 'marketplace_preferences', now() + interval '30 days')`,
          [operationsSession],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
