import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env["TEST_DATABASE_URL"];

it.skipIf(!url)(
  "activates provisioning hotels that are complete today, once, with an audit row (VAY-2140)",
  async () => {
    assertSafeTestDatabase(url!);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const migration = await readFile(
      new URL("../migrations/0482_hotel_catalog_activate_complete_hotels.sql", import.meta.url),
      "utf8",
    );
    const hotels = {
      complete: randomUUID(),
      staleFlags: randomUUID(),
      legacyFlagsOnly: randomUUID(),
      missingPhoto: randomUUID(),
      suspended: randomUUID(),
      private: randomUUID(),
      active: randomUUID(),
    };
    // [id, lifecycle, profile status, stored reasons, has description, has public photo]
    const rows: [string, string, string, string[], boolean, boolean][] = [
      [hotels.complete, "provisioning", "complete", [], true, true],
      [hotels.staleFlags, "provisioning", "incomplete", ["media"], true, true],
      [hotels.legacyFlagsOnly, "provisioning", "complete", [], false, false],
      [hotels.missingPhoto, "provisioning", "incomplete", ["media"], true, false],
      [hotels.suspended, "suspended", "disabled", [], true, true],
      [hotels.private, "provisioning", "private", [], true, true],
      [hotels.active, "active", "complete", [], true, true],
    ];
    try {
      await client.query("BEGIN");
      // Fixture rows only; the migration itself runs with every trigger and constraint.
      await client.query("SET LOCAL session_replication_role = replica");
      for (const [id, lifecycle, profile, reasons, description, photo] of rows) {
        await client.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, default_locale, lifecycle_status, lifecycle_revision,
              profile_status, completeness_reasons)
           VALUES ($1, $2, 'Backfill hotel', 'en', $3, 1, $4, $5::text[])`,
          [id, `backfill-${id}`, lifecycle, profile, reasons],
        );
        if (description)
          await client.query(
            "INSERT INTO hotel_catalog.property_profiles (property_id, locale, short_description) VALUES ($1, 'en', 'A calm hotel by the sea.')",
            [id],
          );
        if (photo) await insertPublicPhoto(client, id);
      }
      await client.query("SET LOCAL session_replication_role = origin");
      const state = async () =>
        (
          await client.query(
            `SELECT property.id::text, property.lifecycle_status AS status,
                    property.lifecycle_revision::int AS revision,
                    property.profile_status AS profile, count(audit.id)::int AS audits
             FROM hotel_catalog.properties property
             LEFT JOIN platform.product_audit_events audit ON audit.property_id = property.id
               AND audit.action = 'hotel_catalog.property.lifecycle.auto_activate'
             WHERE property.id = ANY($1::uuid[])
             GROUP BY property.id ORDER BY property.id`,
            [Object.values(hotels)],
          )
        ).rows;

      await client.query(migration);
      const once = await state();
      const byId = new Map(once.map((row) => [row.id, row]));
      for (const id of [hotels.complete, hotels.staleFlags])
        expect(byId.get(id)).toMatchObject({
          status: "active",
          revision: 2,
          profile: "complete",
          audits: 1,
        });
      for (const id of [hotels.legacyFlagsOnly, hotels.missingPhoto, hotels.private])
        expect(byId.get(id)).toMatchObject({ status: "provisioning", revision: 1, audits: 0 });
      expect(byId.get(hotels.suspended)).toMatchObject({ status: "suspended", audits: 0 });
      expect(byId.get(hotels.active)).toMatchObject({ status: "active", revision: 1, audits: 0 });
      const audit = await client.query(
        `SELECT actor_type, redacted_payload, audit_metadata FROM platform.product_audit_events
         WHERE property_id = $1 AND action = 'hotel_catalog.property.lifecycle.auto_activate'`,
        [hotels.complete],
      );
      expect(audit.rows).toEqual([
        {
          actor_type: "migration",
          redacted_payload: { status: "active", revision: 2 },
          audit_metadata: { reason: "setup_profile_complete", migration: "0482" },
        },
      ]);

      await client.query(migration);
      expect(await state()).toEqual(once);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);

/** An approved public platform photo, as Present your hotel leaves it. */
async function insertPublicPhoto(client: pg.Client, propertyId: string) {
  const mediaId = randomUUID();
  const checksum = createHash("sha256").update(`${mediaId}:original_safe`).digest("hex");
  const path = `media/${mediaId}/original_safe/sha256-${checksum}.webp`;
  await client.query(
    `INSERT INTO platform.media_objects (
       id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
       resource_product, resource_type, resource_id, lifecycle_status, content_type,
       width_px, height_px, size_bytes, checksum_sha256, public_approved
     ) VALUES ($1, 'vayada-media-test', $2, 'vayada_managed', 'public', 'property.hero_image', $3::uuid,
       'hotel_catalog', 'property', $3::text, 'active', 'image/webp', 1200, 800, 900, $4, TRUE)`,
    [mediaId, `public/${path}`, propertyId, checksum],
  );
  await client.query(
    `INSERT INTO platform.media_variants (
       media_object_id, variant_name, visibility, storage_key, content_type,
       width_px, height_px, size_bytes, checksum_sha256, public_cdn_url
     ) VALUES ($1, 'original_safe', 'public', $2, 'image/webp', 1200, 800, 900, $3, $4)`,
    [mediaId, `public/${path}`, checksum, `https://cdn.example.test/${path}`],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_media
       (property_id, media_type, url, sort_order, source_system, public_approved,
        platform_media_object_id)
     VALUES ($1, 'hero_image', $2, 0, 'platform', TRUE, $3)`,
    [propertyId, `https://cdn.example.test/${path}`, mediaId],
  );
}
