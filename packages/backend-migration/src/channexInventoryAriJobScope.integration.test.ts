import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("Channex inventory ARI job scope", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  it("keeps rule work restricted and inventory work availability-capable", async () => {
    assertSafeTestDatabase(url!);
    const propertyId = randomUUID(),
      connectionId = randomUUID(),
      externalPropertyId = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'ARI scope test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO pms.channel_binding_claims
         (property_id,provider,external_property_id,claim_state,claim_source)
       VALUES($1,'channex',$2,'active','enable')`,
      [propertyId, externalPropertyId],
    );
    await pool.query(
      `INSERT INTO pms.channel_connections
         (id,property_id,provider,connection_status,external_property_id)
       VALUES($1,$2,'channex','connected',$3)`,
      [connectionId, propertyId, externalPropertyId],
    );

    await pool.query("SELECT pms.enqueue_restriction_ari($1,'rules:test')", [propertyId]);
    await pool.query("SELECT pms.enqueue_inventory_ari($1,'inventory:test')", [propertyId]);

    expect(
      (
        await pool.query(
          `SELECT payload->>'commandId' AS source,
             (payload->>'restrictionsOnly')::boolean AS "restrictionsOnly",
             job_metadata->>'source' AS owner
           FROM platform.jobs WHERE property_id=$1 AND job_type='channex.sync_ari'
           ORDER BY source`,
          [propertyId],
        )
      ).rows,
    ).toEqual([
      { source: "inventory:test", restrictionsOnly: false, owner: "canonical_inventory" },
      { source: "rules:test", restrictionsOnly: true, owner: "canonical_restrictions" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT pg_get_functiondef('pms.inventory_outbox_ari_changed()'::regprocedure) AS definition",
        )
      ).rows[0].definition,
    ).toContain("enqueue_inventory_ari");
  });
});
