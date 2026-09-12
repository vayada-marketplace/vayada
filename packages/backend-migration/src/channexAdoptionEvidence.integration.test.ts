import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import {
  consumeSignedChannexAdoptionManifest,
  type ChannexAdoptionConsumerConfig,
} from "./channexAdoptionConsumer.js";
import type { ChannexAdoptionManifest } from "./channexAdoptionManifest.js";
import {
  canonicalizeJson,
  hashApprovalSubject,
  hashExpectedDatabaseName,
  hashOrderedSourceRows,
  hashSnapshotIdentifier,
  hashSourceLedger,
  hashTargetBindingClaims,
  type SourceLedger,
} from "./channexAdoptionManifestCrypto.js";
import { readAdoptionTargetRow } from "./channexAdoptionTargetRows.js";
import { VAY_1350_ACTIVE_SOURCE_TABLES } from "./productionIdentitySnapshotReader.js";
import { runProductionCatalogMigration } from "./productionCatalogMigration.js";
import { runProductionIdentityMigration } from "./productionIdentityMigration.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";
import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const DATABASE = "vayada_channex_adoption_evidence_test";
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const RUN = "vay1351-196300000000000000000001";
const USER = uuid(1);
const PROPERTY = uuid(2);
const LEGACY_HOTEL = uuid(3);
const EXTERNAL_PROPERTY = uuid(4);
const CONNECTION = uuid(5);
const MANIFEST = uuid(6);
const APPROVALS = [uuid(7), uuid(8)] as const;
const SOURCE_TIME = "2026-09-12T09:00:00.000000Z";
const SOURCE_DATE = "2026-09-12T09:00:00.000Z";
const ISSUED_AT = "2026-09-12T10:00:00.000Z";
const EXPIRES_AT = "2026-09-12T11:00:00.000Z";
const NOW = new Date("2026-09-12T10:30:00.000Z");
const HASH = "a".repeat(64);

describe.skipIf(!TEST_DATABASE_URL)("Channex adoption production evidence (PostgreSQL)", () => {
  it("consumes one complete migrated fixture through the real evidence readers", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    const adminUrl = new URL(TEST_DATABASE_URL!);
    adminUrl.pathname = "/postgres";
    const targetUrl = new URL(TEST_DATABASE_URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const admin = new pg.Client({ connectionString: adminUrl.href });
    let client: pg.Client | undefined;
    let pool: pg.Pool | undefined;
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
      client = new pg.Client({ connectionString: targetUrl.href });
      await client.connect();
      const ledger = await seedSource(client);

      await expect(
        runProductionIdentityMigration({
          connectionString: targetUrl.href,
          sourceRunId: RUN,
          mode: "apply",
        }),
      ).resolves.toMatchObject({ applied: true, blockers: [] });
      await expect(
        runProductionCatalogMigration({
          connectionString: targetUrl.href,
          sourceRunId: RUN,
          mode: "apply",
        }),
      ).resolves.toMatchObject({ applied: true, blockers: [], quarantinedSources: [] });

      const ownership = await addCanonicalOwnership(client);
      const manifest = await buildManifest(client, ledger, ownership);
      await insertApprovals(client, manifest);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const signature = sign(null, Buffer.from(canonicalizeJson(manifest)), privateKey).toString(
        "base64url",
      );
      const config: ChannexAdoptionConsumerConfig = {
        environment: "local",
        executionPrincipal: "iam:migration-runner",
        allowedExecutionPrincipals: new Set(["iam:migration-runner"]),
        verificationKeys: new Map([[manifest.signingKeyId, publicKey]]),
        signingPrincipals: new Map([[manifest.signingKeyId, "kms:manifest-signer"]]),
        approvalPrincipals: new Map([[USER, "user:flamur-maliqi"]]),
        singleHumanDualAuthority: {
          actorUserId: USER,
          principal: "user:flamur-maliqi",
          decisionId: "VAY-1320@2026-09-12",
        },
        now: () => NOW,
      };
      pool = new pg.Pool({ connectionString: targetUrl.href, max: 2 });

      const consumed = await consumeSignedChannexAdoptionManifest(
        pool,
        { raw: JSON.stringify(manifest), detachedSignature: signature },
        config,
      );
      expect(consumed).toMatchObject({ manifestId: MANIFEST, replayed: false });
      expect(
        (
          await pool.query(
            `SELECT claim_state AS "claimState", claim_source AS "claimSource"
               FROM pms.channel_binding_claims WHERE id=$1`,
            [consumed.claimId],
          )
        ).rows[0],
      ).toEqual({ claimState: "verified_non_active", claimSource: "adoption" });
      expect(
        (await pool.query("SELECT count(*)::integer count FROM pms.channel_connections")).rows[0],
      ).toEqual({ count: 0 });
    } finally {
      if (pool) await pool.end();
      if (client) await client.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);
});

type SourceRow = { database: "auth" | "booking" | "pms"; table: string; data: object };

const SOURCE_ROWS: SourceRow[] = [
  {
    database: "auth",
    table: "users",
    data: {
      id: USER,
      email: "vay-1963@example.test",
      name: "VAY-1963 Owner",
      status: "verified",
      type: "hotel",
      email_verified: true,
      is_superadmin: false,
      marketing_consent: false,
      created_at: SOURCE_DATE,
      updated_at: SOURCE_DATE,
    },
  },
  {
    database: "booking",
    table: "booking_hotels",
    data: {
      id: PROPERTY,
      user_id: USER,
      name: "VAY-1963 Hotel",
      slug: "vay-1963-hotel",
      platform_status: "live",
      country: "AT",
      timezone: "Europe/Vienna",
      supported_languages: ["en"],
      default_language: "en",
      previous_slugs: [],
      amenities: [],
      images: [],
      created_at: SOURCE_DATE,
      updated_at: SOURCE_DATE,
    },
  },
  {
    database: "pms",
    table: "hotels",
    data: {
      id: LEGACY_HOTEL,
      user_id: USER,
      name: "VAY-1963 Hotel",
      slug: "vay-1963-pms-hotel",
      country: "AT",
      city: "Vienna",
      timezone: "Europe/Vienna",
      created_at: SOURCE_DATE,
      updated_at: SOURCE_DATE,
    },
  },
  {
    database: "pms",
    table: "channex_connections",
    data: {
      id: CONNECTION,
      hotel_id: LEGACY_HOTEL,
      channex_property_id: EXTERNAL_PROPERTY,
      is_active: true,
    },
  },
];

async function seedSource(client: pg.Client): Promise<SourceLedger> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id,environment,source_schema_revision,status,started_at,finished_at,duration_ms)
     VALUES($1,'local',$2,'completed',$3,$3,0)`,
    [RUN, VAY_1350_INVENTORY_REVISION, SOURCE_TIME],
  );
  for (const row of SOURCE_ROWS)
    await client.query(
      `INSERT INTO migration_source_${row.database}.snapshot_rows
         (run_id,snapshot_identifier,source_schema,source_table,row_ordinal,
          row_checksum_sha256,row_data)
       VALUES($1,$2,'public',$3,1,
              encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex'),$4::jsonb)`,
      [RUN, `snapshot-${row.database}`, row.table, JSON.stringify(row.data)],
    );

  const tables: SourceLedger["tables"] = [];
  const sources: SourceLedger["sources"] = [];
  for (const database of ["auth", "booking", "marketplace", "pms"] as const) {
    let sourceCount = 0;
    const sourceChecksum = createHash("sha256");
    for (const qualifiedTable of VAY_1350_ACTIVE_SOURCE_TABLES[database]) {
      const [sourceSchema, sourceTable] = qualifiedTable.split(".") as [string, string];
      const rows = await client.query<{ checksum: string }>(
        `SELECT row_checksum_sha256 AS checksum
           FROM migration_source_${database}.snapshot_rows
          WHERE run_id=$1 AND source_schema=$2 AND source_table=$3 ORDER BY row_ordinal`,
        [RUN, sourceSchema, sourceTable],
      );
      const checksum = createHash("sha256");
      for (const row of rows.rows) checksum.update(`${row.checksum}\n`);
      const tableChecksum = checksum.digest("hex");
      sourceCount += rows.rows.length;
      sourceChecksum.update(`${qualifiedTable}|${rows.rows.length}|${tableChecksum}\n`);
      tables.push({
        source_database: database,
        source_schema: sourceSchema,
        source_table: sourceTable,
        status: "completed",
        row_count: rows.rows.length,
        checksum_sha256: tableChecksum,
      });
    }
    const aggregate = sourceChecksum.digest("hex");
    await client.query(
      `INSERT INTO platform.source_extraction_sources
         (run_id,source_database,snapshot_identifier,expected_database_name,
          expected_schema_fingerprint,actual_schema_fingerprint,status,row_count,
          checksum_sha256,source_snapshot_at,started_at,finished_at,duration_ms)
       VALUES($1,$2,$3,$2,$4,$4,'completed',$5,$6,$7,$7,$7,0)`,
      [RUN, database, `snapshot-${database}`, "f".repeat(32), sourceCount, aggregate, SOURCE_TIME],
    );
    sources.push({
      source_database: database,
      snapshot_identifier_sha256: hashSnapshotIdentifier(`snapshot-${database}`),
      expected_database_name_sha256: hashExpectedDatabaseName(database),
      expected_schema_fingerprint: "f".repeat(32),
      actual_schema_fingerprint: "f".repeat(32),
      status: "completed",
      row_count: sourceCount,
      checksum_sha256: aggregate,
      source_snapshot_at: SOURCE_TIME,
    });
  }
  for (const table of tables)
    await client.query(
      `INSERT INTO platform.source_extraction_tables
         (run_id,source_database,source_schema,source_table,status,row_count,
          checksum_sha256,started_at,finished_at,duration_ms)
       VALUES($1,$2,$3,$4,'completed',$5,$6,$7,$7,0)`,
      [
        RUN,
        table.source_database,
        table.source_schema,
        table.source_table,
        table.row_count,
        table.checksum_sha256,
        SOURCE_TIME,
      ],
    );
  return {
    run: {
      run_id: RUN,
      environment: "local",
      source_schema_revision: VAY_1350_INVENTORY_REVISION,
      cutover_freeze_proof_sha256: null,
      status: "completed",
      finished_at: SOURCE_TIME,
    },
    sources,
    tables: tables.sort((left, right) =>
      `${left.source_database}\0${left.source_schema}\0${left.source_table}`.localeCompare(
        `${right.source_database}\0${right.source_schema}\0${right.source_table}`,
      ),
    ),
  };
}

async function addCanonicalOwnership(client: pg.Client) {
  const legacy = (
    await client.query<{ id: string; organizationId: string }>(
      `SELECT id::text,organization_id::text AS "organizationId"
         FROM identity.organization_resource_links
        WHERE product='pms' AND resource_type='pms_hotel' AND resource_id=$1`,
      [LEGACY_HOTEL],
    )
  ).rows[0]!;
  const inserted = await client.query<{ id: string; product: string }>(
    `INSERT INTO identity.organization_resource_links
       (organization_id,product,resource_type,resource_id,relationship,status)
     VALUES($1,'hotel_catalog','property',$2,'owner','active'),
           ($1,'pms','pms_property',$2,'operator','active')
     RETURNING id::text,product`,
    [legacy.organizationId, PROPERTY],
  );
  return {
    organizationId: legacy.organizationId,
    legacyResourceLinkId: legacy.id,
    targetResourceLinkId: inserted.rows.find((row) => row.product === "hotel_catalog")!.id,
    targetPmsResourceLinkId: inserted.rows.find((row) => row.product === "pms")!.id,
  };
}

async function buildManifest(
  client: pg.Client,
  ledger: SourceLedger,
  ownership: Awaited<ReturnType<typeof addCanonicalOwnership>>,
): Promise<ChannexAdoptionManifest> {
  const sourceLinkId = (
    await client.query<{ id: string }>(
      `SELECT id::text FROM hotel_catalog.property_source_links
        WHERE source_system='pms' AND source_table='hotels' AND source_id=$1`,
      [LEGACY_HOTEL],
    )
  ).rows[0]!.id;
  const legacyRows = await client.query<{
    sourceTable: string;
    rowOrdinal: string;
    rowChecksumSha256: string;
  }>(
    `SELECT source_table AS "sourceTable",row_ordinal::text AS "rowOrdinal",
            row_checksum_sha256 AS "rowChecksumSha256"
       FROM migration_source_pms.snapshot_rows
      WHERE run_id=$1 AND source_table=ANY($2::text[]) ORDER BY source_table`,
    [RUN, ["hotels", "channex_connections"]],
  );
  const evidence = new Map(legacyRows.rows.map((row) => [row.sourceTable, row]));
  const targetRows = [];
  for (const [table, id] of [
    ["hotel_catalog.properties", PROPERTY],
    ["hotel_catalog.property_source_links", sourceLinkId],
    ["identity.organization_resource_links", ownership.legacyResourceLinkId],
    ["identity.organization_resource_links", ownership.targetResourceLinkId],
    ["identity.organization_resource_links", ownership.targetPmsResourceLinkId],
    ["identity.organizations", ownership.organizationId],
  ] as const)
    targetRows.push(await readAdoptionTargetRow(client, table, id));
  const empty = (kind: Parameters<typeof hashOrderedSourceRows>[0]) => ({
    rowCount: 0,
    orderedRowsSha256: hashOrderedSourceRows(kind, []),
  });
  const manifest: ChannexAdoptionManifest = {
    contractVersion: "channex-property-adoption.v1",
    manifestId: MANIFEST,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    environment: "local",
    sourceEnvironment: "local",
    sourceRunId: RUN,
    sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
    sourceEvidenceSha256: hashSourceLedger(ledger),
    legacyPmsHotelId: LEGACY_HOTEL,
    externalPropertyId: EXTERNAL_PROPERTY,
    targetPropertyId: PROPERTY,
    targetOrganizationId: ownership.organizationId,
    targetSourceLinkId: sourceLinkId,
    legacyResourceLinkId: ownership.legacyResourceLinkId,
    targetResourceLinkId: ownership.targetResourceLinkId,
    targetPmsResourceLinkId: ownership.targetPmsResourceLinkId,
    legacyEvidence: {
      hotel: {
        rowOrdinal: Number(evidence.get("hotels")!.rowOrdinal),
        rowChecksumSha256: evidence.get("hotels")!.rowChecksumSha256,
        userId: USER,
      },
      connection: {
        rowOrdinal: Number(evidence.get("channex_connections")!.rowOrdinal),
        rowChecksumSha256: evidence.get("channex_connections")!.rowChecksumSha256,
      },
      roomTypeMappings: empty("pms-channex-room-type-mappings"),
      ratePlanMappings: empty("pms-channex-rate-plan-mappings"),
      bookingMappings: empty("pms-channex-booking-mappings"),
      bookings: empty("pms-bookings"),
    },
    targetEvidence: {
      property: targetRows[0]!,
      sourceLink: {
        ...targetRows[1]!,
        migrationRunId: RUN,
        migrationPhase: "complete",
        migrationDisposition: "canonical",
      },
      legacyResourceLink: targetRows[2]!,
      targetResourceLink: targetRows[3]!,
      targetPmsResourceLink: targetRows[4]!,
      organization: targetRows[5]!,
      bindingClaims: { rowCount: 0, orderedRowsSha256: hashTargetBindingClaims([]) },
    },
    approvalSubjectSha256: HASH,
    approvalEvidence: [
      approval(APPROVALS[0], "migration_owner", 1),
      approval(APPROVALS[1], "security_owner", 2),
    ],
    signingKeyId: "migration-local-2026-01",
  };
  const subject = hashApprovalSubject(manifest as unknown as Record<string, unknown>);
  manifest.approvalSubjectSha256 = subject;
  manifest.approvalEvidence.forEach((row) => (row.approvalSubjectSha256 = subject));
  return manifest;
}

function approval(
  approvalRecordId: string,
  authority: "migration_owner" | "security_owner",
  registryRevision: number,
) {
  return {
    approvalRecordId,
    authority,
    actorUserId: USER,
    approvedAt: "2026-09-12T10:05:00.000Z",
    approvalSubjectSha256: HASH,
    registryRevision,
    rowStateSha256: HASH,
  };
}

async function insertApprovals(client: pg.Client, manifest: ChannexAdoptionManifest) {
  for (const row of manifest.approvalEvidence)
    await client.query(
      `INSERT INTO platform.channex_adoption_approval_records
         (approval_record_id,manifest_id,environment,expires_at,authority,actor_user_id,
          approved_at,approval_subject_sha256,registry_revision,row_state_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.approvalRecordId,
        manifest.manifestId,
        manifest.environment,
        manifest.expiresAt,
        row.authority,
        row.actorUserId,
        row.approvedAt,
        row.approvalSubjectSha256,
        row.registryRevision,
        row.rowStateSha256,
      ],
    );
}

function uuid(value: number): string {
  return `19630000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
