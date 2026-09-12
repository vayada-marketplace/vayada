import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const DATABASE = "vayada_channex_adoption_foundation_test";
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const IDS = [1, 2, 3].map(
  (value) => `19620000-0000-4000-8000-${value.toString().padStart(12, "0")}`,
);
const MANIFESTS = [11, 12, 13].map(
  (value) => `19620000-0000-4000-8000-${value.toString().padStart(12, "0")}`,
);
const HASHES = ["a", "b", "c", "d"].map((value) => value.repeat(64));

describe.skipIf(!DATABASE_URL)("Channex adoption manifest persistence", () => {
  it("keeps approvals, revocations, and consumption results immutable", async () => {
    assertSafeTestDatabase(DATABASE_URL!);
    const adminUrl = new URL(DATABASE_URL!);
    adminUrl.pathname = "/postgres";
    const targetUrl = new URL(DATABASE_URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const admin = new pg.Client({ connectionString: adminUrl.href });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      expect(
        (
          await runMigrations({
            connectionString: targetUrl.href,
            migrationsDir: MIGRATIONS,
            environment: "local",
          })
        ).failed,
      ).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      await target.query(
        `INSERT INTO identity.users(id,email) VALUES
         ($1,'migration@example.test'),($2,'security@example.test'),($3,'revoker@example.test')`,
        IDS,
      );

      const approve = (manifestId: string, authority: string, actorId: string, recordId: string) =>
        target!.query(
          `INSERT INTO platform.channex_adoption_approval_records
           (approval_record_id,manifest_id,environment,expires_at,authority,actor_user_id,
            approved_at,approval_subject_sha256,registry_revision,row_state_sha256)
           VALUES($1,$2,'local',now()+interval '1 hour',$3,$4,now(),$5,1,$6)`,
          [recordId, manifestId, authority, actorId, HASHES[0], HASHES[1]],
        );

      await approve(MANIFESTS[0]!, "migration_owner", IDS[0]!, IDS[0]!);
      await approve(MANIFESTS[0]!, "security_owner", IDS[1]!, IDS[1]!);
      await expect(
        approve(MANIFESTS[0]!, "migration_owner", IDS[2]!, IDS[2]!),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_channex_adoption_approval_authority",
      });

      await approve(MANIFESTS[1]!, "migration_owner", IDS[0]!, MANIFESTS[1]!);
      await expect(
        approve(MANIFESTS[1]!, "security_owner", IDS[0]!, IDS[2]!),
      ).resolves.toBeDefined();
      expect(
        (
          await target.query(
            `SELECT count(*)::integer count
               FROM platform.channex_adoption_approval_records
              WHERE manifest_id=$1 AND actor_user_id=$2`,
            [MANIFESTS[1], IDS[0]],
          )
        ).rows[0],
      ).toEqual({ count: 2 });

      await target.query(
        `INSERT INTO platform.channex_adoption_approval_revocations
         (approval_record_id,revoked_by_user_id,revoked_at,reason_sha256)
         VALUES($1,$2,now(),$3)`,
        [IDS[1], IDS[2], HASHES[2]],
      );
      await expect(
        target.query(
          "UPDATE platform.channex_adoption_approval_records SET registry_revision=2 WHERE approval_record_id=$1",
          [IDS[0]],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        target.query(
          "DELETE FROM platform.channex_adoption_approval_revocations WHERE approval_record_id=$1",
          [IDS[1]],
        ),
      ).rejects.toMatchObject({ code: "55000" });

      const consumptionValues = [
        MANIFESTS[0],
        HASHES[2],
        "vay1351-0123456789abcdef01234567",
        IDS[0],
        IDS[1],
        IDS[2],
        MANIFESTS[2],
        Buffer.alloc(64),
      ];
      await target.query(
        `INSERT INTO platform.channex_adoption_manifest_consumptions
         (manifest_id,payload_sha256,contract_version,environment,source_environment,source_run_id,
          legacy_pms_hotel_id,external_property_id,target_property_id,target_organization_id,
          signing_key_id,signature_algorithm,detached_signature,signature_verified,outcome,failure_code)
         VALUES($1,$2,'channex-property-adoption.v1','local','local',$3,$4,$5,$6,$7,
                'migration/channex-adoption/2026-09','ed25519',$8,true,'failed','OWNERSHIP_MISMATCH')`,
        consumptionValues,
      );
      expect(
        (
          await target.query(
            `SELECT payload_sha256 AS hash,outcome,failure_code AS failure
           FROM platform.channex_adoption_manifest_consumptions WHERE manifest_id=$1`,
            [MANIFESTS[0]],
          )
        ).rows[0],
      ).toEqual({ hash: HASHES[2], outcome: "failed", failure: "OWNERSHIP_MISMATCH" });
      await expect(
        target.query(
          `INSERT INTO platform.channex_adoption_manifest_consumptions
           (manifest_id,payload_sha256,contract_version,environment,source_environment,source_run_id,
            legacy_pms_hotel_id,external_property_id,target_property_id,target_organization_id,
            signing_key_id,signature_algorithm,detached_signature,signature_verified,outcome,failure_code)
           VALUES($1,$2,'channex-property-adoption.v1','local','local',$3,$4,$5,$6,$7,
                  'migration/channex-adoption/2026-09','ed25519',$8,true,'failed','PAYLOAD_DRIFT')`,
          [MANIFESTS[0], HASHES[3], ...consumptionValues.slice(2)],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        target.query(
          "UPDATE platform.channex_adoption_manifest_consumptions SET failure_code='CHANGED' WHERE manifest_id=$1",
          [MANIFESTS[0]],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        target.query("TRUNCATE platform.channex_adoption_manifest_consumptions"),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|0A000)$/) });
      expect(
        (await target.query("SELECT count(*)::integer count FROM pms.channel_binding_claims"))
          .rows[0],
      ).toEqual({ count: 0 });

      await target.query("BEGIN");
      await approve(MANIFESTS[2]!, "migration_owner", IDS[2]!, MANIFESTS[2]!);
      await target.query("ROLLBACK");
      expect(
        (
          await target.query(
            "SELECT count(*)::integer count FROM platform.channex_adoption_approval_records WHERE manifest_id=$1",
            [MANIFESTS[2]],
          )
        ).rows[0],
      ).toEqual({ count: 0 });
    } finally {
      if (target) await target.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);
});
