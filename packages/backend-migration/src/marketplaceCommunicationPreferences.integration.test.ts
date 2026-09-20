import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0400_marketplace_communication_preferences.sql"),
  "utf8",
);
const databaseUrl = process.env["TEST_DATABASE_URL"];
const userId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000001";

describe.skipIf(!databaseUrl)("Marketplace communication preferences (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(databaseUrl!);
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS marketplace CASCADE;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE SCHEMA marketplace;
      CREATE TABLE identity.users (id UUID PRIMARY KEY);
      CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
      INSERT INTO identity.users VALUES ('${userId}');
      INSERT INTO identity.organizations VALUES ('${organizationId}');
    `);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("ROLLBACK");
      await client.query("DROP SCHEMA IF EXISTS marketplace CASCADE");
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("binds value changes to the transaction that advances the document revision", async () => {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO marketplace.communication_preference_sets
         (user_id, organization_id, updated_by_user_id) VALUES ($1, $2, $1)`,
      [userId, organizationId],
    );
    await client.query(
      `INSERT INTO marketplace.communication_topic_preferences
         (user_id, organization_id, topic, channel, cadence, source,
          consent_classification, effective_revision, policy_version, effective_at,
          updated_by_user_id)
       VALUES ($1, $2, 'collaboration_action_required', 'email', 'off',
         'signed_unsubscribe', 'service', 1, 'marketplace-communications.v1', now(), $1)`,
      [userId, organizationId],
    );
    await client.query("COMMIT");

    await expect(
      client.query(
        `INSERT INTO marketplace.communication_channel_preferences
           (user_id, organization_id, channel, state, source, effective_revision,
            policy_version, effective_at, updated_by_user_id)
         VALUES ($1, $2, 'email', 'off', 'settings', 1,
           'marketplace-communications.v1', now(), $1)`,
        [userId, organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("TRUNCATE marketplace.communication_topic_preferences"),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      await client.query("SELECT 1 FROM marketplace.communication_topic_preferences"),
    ).toMatchObject({ rowCount: 1 });
    await expect(
      client.query(
        `UPDATE marketplace.communication_preference_sets
         SET revision = 2, updated_at = now() WHERE user_id = $1 AND organization_id = $2`,
        [userId, organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await client.query("BEGIN");
    await client.query(
      `UPDATE marketplace.communication_preference_sets
       SET revision = 2, updated_at = now() WHERE user_id = $1 AND organization_id = $2`,
      [userId, organizationId],
    );
    await client.query(
      `UPDATE marketplace.communication_topic_preferences
       SET cadence = 'immediate', source = 'settings', effective_revision = 2,
           updated_at = now() WHERE user_id = $1 AND organization_id = $2`,
      [userId, organizationId],
    );
    await client.query("COMMIT");

    const stored = await client.query<{ revision: number; effectiveRevision: number }>(
      `SELECT sets.revision, topic.effective_revision AS "effectiveRevision"
       FROM marketplace.communication_preference_sets sets
       JOIN marketplace.communication_topic_preferences topic USING (user_id, organization_id)`,
    );
    expect(stored.rows).toEqual([{ revision: 2, effectiveRevision: 2 }]);
  });
});
