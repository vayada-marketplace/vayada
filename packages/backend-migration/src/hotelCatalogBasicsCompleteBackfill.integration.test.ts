import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env["TEST_DATABASE_URL"];

it.skipIf(!url)(
  "marks hotels with their basics complete, never marks one incomplete and never makes one live (VAY-2247)",
  async () => {
    assertSafeTestDatabase(url!);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const migration = await readFile(
      new URL("../migrations/0495_hotel_catalog_basics_complete_backfill.sql", import.meta.url),
      "utf8",
    );
    const hotels = {
      basicsProvisioning: randomUUID(),
      basicsActive: randomUUID(),
      missingPhone: randomUUID(),
      missingStreet: randomUUID(),
      completeWithoutBasics: randomUUID(),
      disabled: randomUUID(),
      privateHotel: randomUUID(),
    };
    // [id, lifecycle, profile status, street, has email, has phone]
    const rows: [string, string, string, string, boolean, boolean][] = [
      [hotels.basicsProvisioning, "provisioning", "incomplete", "Lighthouse Street 12", true, true],
      [hotels.basicsActive, "active", "incomplete", "Sendlinger Straße 12", true, true],
      [hotels.missingPhone, "provisioning", "incomplete", "Lighthouse Street 12", true, false],
      [hotels.missingStreet, "provisioning", "incomplete", "", true, true],
      [hotels.completeWithoutBasics, "active", "complete", "", false, false],
      [hotels.disabled, "suspended", "disabled", "Lighthouse Street 12", true, true],
      [hotels.privateHotel, "provisioning", "private", "Lighthouse Street 12", true, true],
    ];
    try {
      await client.query("BEGIN");
      // Fixture rows only; the migration itself runs with every trigger and constraint.
      await client.query("SET LOCAL session_replication_role = replica");
      for (const [id, lifecycle, profile, street, email, phone] of rows) {
        await client.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, property_type, default_locale, lifecycle_status,
              lifecycle_revision, profile_status, completeness_reasons)
           VALUES ($1, $2, 'Backfill hotel', 'hotel', 'en', $3, 1, $4,
             CASE WHEN $4 = 'incomplete' THEN ARRAY['description','media'] ELSE '{}' END::text[])`,
          [id, `basics-${id}`, lifecycle, profile],
        );
        await client.query(
          `INSERT INTO hotel_catalog.property_locations
             (property_id, country_code, city, street_address, postal_code, timezone)
           VALUES ($1, 'LK', 'Galle', $2, '80000', 'Asia/Colombo')`,
          [id, street],
        );
        for (const [channel, value, present] of [
          ["email", "reception@backfill.example.test", email],
          ["phone", "+94 91 222 3344", phone],
        ] as const)
          if (present)
            await client.query(
              `INSERT INTO hotel_catalog.property_contact_channels
                 (property_id, channel_type, value, purpose, is_public, source_system)
               VALUES ($1, $2, $3, 'general', TRUE, 'platform')`,
              [id, channel, value],
            );
      }
      await client.query("SET LOCAL session_replication_role = origin");
      const state = async () =>
        (
          await client.query(
            `SELECT id::text, lifecycle_status AS lifecycle, lifecycle_revision::int AS revision,
                    profile_status AS profile, completeness_reasons AS reasons
             FROM hotel_catalog.properties WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [Object.values(hotels)],
          )
        ).rows;

      await client.query(migration);
      const once = await state();
      const byId = new Map(once.map((row) => [row.id, row]));
      // Promoted, but nobody goes live: setup does that.
      expect(byId.get(hotels.basicsProvisioning)).toMatchObject({
        lifecycle: "provisioning",
        revision: 1,
        profile: "complete",
        reasons: [],
      });
      expect(byId.get(hotels.basicsActive)).toMatchObject({
        lifecycle: "active",
        profile: "complete",
        reasons: [],
      });
      // Missing basics stay as they were; a stored "complete" is never taken away.
      for (const id of [hotels.missingPhone, hotels.missingStreet])
        expect(byId.get(id)).toMatchObject({
          profile: "incomplete",
          reasons: ["description", "media"],
        });
      expect(byId.get(hotels.completeWithoutBasics)).toMatchObject({ profile: "complete" });
      expect(byId.get(hotels.disabled)).toMatchObject({
        lifecycle: "suspended",
        profile: "disabled",
      });
      expect(byId.get(hotels.privateHotel)).toMatchObject({ profile: "private" });

      await client.query(migration);
      expect(await state()).toEqual(once);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
