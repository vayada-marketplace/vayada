import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { describe, expect, it } from "vitest";

import type { ChannexAdoptionManifest } from "./channexAdoptionManifest.js";
import {
  canonicalizeJson,
  hashApprovalSubject,
  hashExpectedDatabaseName,
  hashOrderedSourceRows,
  hashRollbackReason,
  hashRollbackSubject,
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
const REPOSITORY = join(import.meta.dirname, "../../..");
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
const CLOCK = Date.now();
const ISSUED_AT = new Date(CLOCK - 60_000).toISOString();
const EXPIRES_AT = new Date(CLOCK + 10 * 60_000).toISOString();
const APPROVED_AT = new Date(CLOCK - 30_000).toISOString();
const HASH = "a".repeat(64);
const RAW_GUEST_PAYLOAD_SENTINEL = "vay1964-raw-guest-payload-must-not-appear";
const PROVIDER_SECRET_SENTINEL = "vay1964-provider-secret-must-not-appear";
const EXECUTION_PRINCIPAL = "iam:vay1964-isolated-rehearsal-executor";
const SIGNING_PRINCIPAL = "fixture-key:vay1964-ephemeral-signer";
const APPROVAL_PRINCIPAL = "fixture-user:vay1964-sole-human";
const execFileAsync = promisify(execFile);
const CONSUMPTION_REDACTED_KEYS = [
  "approvalPolicy",
  "approvalRecordIds",
  "expiresAt",
  "externalPropertyId",
  "failureCode",
  "issuedAt",
  "legacyEvidence",
  "legacyPmsHotelId",
  "manifestId",
  "outcome",
  "payloadSha256",
  "preState",
  "signatureAlgorithm",
  "signatureVerified",
  "signingKeyId",
  "sourceEvidenceSha256",
  "sourceRunId",
  "sourceSchemaRevision",
  "targetEvidence",
  "targetOrganizationId",
  "targetPropertyId",
];
const ROLLBACK_REDACTED_KEYS = [
  "approvalActorUserIds",
  "approvalPolicy",
  "approvalRecordIds",
  "claimId",
  "manifestId",
  "rollbackReasonSha256",
  "rollbackSubjectSha256",
  "targetOrganizationId",
  "targetPropertyId",
];

type FixtureIds = {
  run: string;
  user: string;
  property: string;
  legacyHotel: string;
  externalProperty: string;
  connection: string;
  manifest: string;
  approvals: readonly [string, string];
  label: string;
};

const PRIMARY_FIXTURE: FixtureIds = {
  run: RUN,
  user: USER,
  property: PROPERTY,
  legacyHotel: LEGACY_HOTEL,
  externalProperty: EXTERNAL_PROPERTY,
  connection: CONNECTION,
  manifest: MANIFEST,
  approvals: APPROVALS,
  label: "vay-1964-isolated",
};
const SANCTIONED_FIXTURE: FixtureIds = {
  run: "vay1351-196400000000000000000002",
  user: uuid(65),
  property: "65f6b2fc-c783-4963-9d6b-a85f82319769",
  legacyHotel: uuid(60),
  externalProperty: "8f4c1e47-3de1-4150-8bde-ad031a013842",
  connection: uuid(61),
  manifest: uuid(62),
  approvals: [uuid(63), uuid(64)],
  label: "vay-1964-sanctioned-regression",
};

describe.skipIf(!TEST_DATABASE_URL)("Channex adoption rehearsal evidence (PostgreSQL)", () => {
  it("rehearses file-based CLI consumption, replay, and rollback", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    const adminUrl = new URL(TEST_DATABASE_URL!);
    adminUrl.pathname = "/postgres";
    const targetUrl = new URL(TEST_DATABASE_URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const admin = new pg.Client({ connectionString: adminUrl.href });
    const artifacts = await mkdtemp(join(tmpdir(), "vay1964-adoption-"));
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
      const config = {
        environment: "staging",
        allowedExecutionPrincipals: [EXECUTION_PRINCIPAL],
        verificationKeys: [
          {
            id: manifest.signingKeyId,
            publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
            principal: SIGNING_PRINCIPAL,
          },
        ],
        approvalPrincipals: { [USER]: APPROVAL_PRINCIPAL },
        singleHumanDualAuthority: {
          actorUserId: USER,
          principal: APPROVAL_PRINCIPAL,
          decisionId: "VAY-1320@2026-09-12",
        },
      };
      const configPath = join(artifacts, "config.json");
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      pool = new pg.Pool({ connectionString: targetUrl.href, max: 2 });

      const validFiles = await writeSignedManifest(artifacts, "valid", manifest, privateKey);
      const consumed = await runCli(targetUrl.href, "consume", configPath, [
        "--manifest-file",
        validFiles.manifest,
        "--signature-file",
        validFiles.signature,
      ]);
      expect(consumed).toMatchObject({ manifestId: MANIFEST, replayed: false });
      const replay = await runCli(targetUrl.href, "consume", configPath, [
        "--manifest-file",
        validFiles.manifest,
        "--signature-file",
        validFiles.signature,
      ]);
      expect(replay).toEqual({ ...consumed, replayed: true });
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

      const rollbackReason = "VAY-1964 isolated rehearsal cleanup; legacy stays authoritative.";
      const rollbackExpiry = new Date(CLOCK + 9 * 60_000).toISOString();
      const rollbackApprovals = [uuid(50), uuid(51)] as const;
      await insertRollbackApprovals(
        client,
        manifest,
        consumed.claimId,
        rollbackReason,
        rollbackExpiry,
        rollbackApprovals,
      );
      const reasonPath = join(artifacts, "rollback-reason.txt");
      await writeFile(reasonPath, rollbackReason, { mode: 0o600 });
      const rollback = await runCli(targetUrl.href, "rollback", configPath, [
        "--manifest-id",
        MANIFEST,
        "--reason-file",
        reasonPath,
        "--expires-at",
        rollbackExpiry,
        "--approval-record-ids",
        rollbackApprovals.join(","),
      ]);
      expect(rollback).toEqual({ ...consumed, replayed: false });
      const rollbackReplay = await runCli(targetUrl.href, "rollback", configPath, [
        "--manifest-id",
        MANIFEST,
        "--reason-file",
        reasonPath,
        "--expires-at",
        rollbackExpiry,
        "--approval-record-ids",
        rollbackApprovals.join(","),
      ]);
      expect(rollbackReplay).toEqual({ ...consumed, replayed: true });

      const state = (
        await pool.query<{
          claimState: string;
          connectionCount: number;
          legacyConnectionActive: boolean;
          payloadSha256: string;
        }>(
          `SELECT claim.claim_state AS "claimState",
                  (SELECT count(*)::integer FROM pms.channel_connections) AS "connectionCount",
                  (SELECT payload_sha256
                     FROM platform.channex_adoption_manifest_consumptions
                    WHERE manifest_id=$3) AS "payloadSha256",
                  (SELECT (row_data->>'is_active')::boolean
                     FROM migration_source_pms.snapshot_rows
                    WHERE run_id=$2 AND source_table='channex_connections'
                      AND row_ordinal=1) AS "legacyConnectionActive"
             FROM pms.channel_binding_claims claim WHERE claim.id=$1`,
          [consumed.claimId, RUN, MANIFEST],
        )
      ).rows[0]!;
      expect(state).toEqual({
        claimState: "released",
        connectionCount: 0,
        legacyConnectionActive: true,
        payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      const sanctionedLedger = await seedSource(client, SANCTIONED_FIXTURE);
      await expect(
        runProductionIdentityMigration({
          connectionString: targetUrl.href,
          sourceRunId: SANCTIONED_FIXTURE.run,
          mode: "apply",
        }),
      ).resolves.toMatchObject({ applied: true, blockers: [] });
      await expect(
        runProductionCatalogMigration({
          connectionString: targetUrl.href,
          sourceRunId: SANCTIONED_FIXTURE.run,
          mode: "apply",
        }),
      ).resolves.toMatchObject({ applied: true, blockers: [], quarantinedSources: [] });
      const sanctionedOwnership = await addCanonicalOwnership(client, SANCTIONED_FIXTURE);
      await client.query(
        `INSERT INTO pms.channel_binding_claims
           (property_id,provider,external_property_id,claim_state,claim_source)
         VALUES($1,'channex',$2,'active','repair')`,
        [SANCTIONED_FIXTURE.property, SANCTIONED_FIXTURE.externalProperty],
      );
      await client.query(
        `INSERT INTO pms.channel_connections
           (property_id,provider,external_property_id,connection_status)
         VALUES($1,'channex',$2,'connected')`,
        [SANCTIONED_FIXTURE.property, SANCTIONED_FIXTURE.externalProperty],
      );
      const sanctionedManifest = await buildManifest(
        client,
        sanctionedLedger,
        sanctionedOwnership,
        SANCTIONED_FIXTURE,
      );
      await insertApprovals(client, sanctionedManifest);
      const sanctionedFiles = await writeSignedManifest(
        artifacts,
        "sanctioned",
        sanctionedManifest,
        privateKey,
      );
      const sanctionedBefore = await readPairState(client, SANCTIONED_FIXTURE);
      await expectCliFailure(
        runCli(targetUrl.href, "consume", configPath, [
          "--manifest-file",
          sanctionedFiles.manifest,
          "--signature-file",
          sanctionedFiles.signature,
        ]),
        "BINDING_CLAIM_HISTORY_EXISTS",
      );
      expect(await readPairState(client, SANCTIONED_FIXTURE)).toEqual(sanctionedBefore);

      const audits = await pool.query<{
        auditKey: string;
        action: string;
        retentionClass: string;
        privacyScope: string;
        aiVisible: boolean;
        redactedPayload: Record<string, unknown>;
        privatePayload: Record<string, unknown>;
        auditMetadata: Record<string, unknown>;
      }>(
        `SELECT audit_key AS "auditKey", action, retention_class AS "retentionClass",
                privacy_scope AS "privacyScope", ai_visible AS "aiVisible",
                redacted_payload AS "redactedPayload", private_payload AS "privatePayload",
                audit_metadata AS "auditMetadata"
           FROM platform.product_audit_events
          WHERE audit_key=ANY($1::text[]) ORDER BY audit_key`,
        [
          [
            `channex-adoption:${MANIFEST}`,
            `channex-adoption-rollback:${MANIFEST}`,
            `channex-adoption:${SANCTIONED_FIXTURE.manifest}`,
          ],
        ],
      );
      expect(audits.rows).toHaveLength(3);
      for (const audit of audits.rows) {
        expect(audit).toMatchObject({
          retentionClass: "security",
          privacyScope: "restricted",
          aiVisible: false,
        });
        const serialized = JSON.stringify([
          audit.redactedPayload,
          audit.privatePayload,
          audit.auditMetadata,
        ]);
        expect(serialized).not.toContain("vay-1964@example.test");
        expect(serialized).not.toContain("VAY-1964");
        expect(serialized).not.toContain(RAW_GUEST_PAYLOAD_SENTINEL);
        expect(serialized).not.toContain(PROVIDER_SECRET_SENTINEL);
        expect(serialized).not.toContain("PRIVATE KEY");
        expect(audit.auditMetadata).toEqual(
          audit.action === "channex_adoption_released"
            ? {}
            : { contractVersion: "channex-property-adoption.v1" },
        );
        expect(Object.keys(audit.privatePayload).sort()).toEqual(
          audit.action === "channex_adoption_released" ? [] : ["approvalActorUserIds"],
        );
        expect(Object.keys(audit.redactedPayload).sort()).toEqual(
          audit.action === "channex_adoption_released"
            ? ROLLBACK_REDACTED_KEYS
            : CONSUMPTION_REDACTED_KEYS,
        );
      }
      console.log(
        JSON.stringify({
          rehearsal: "VAY-1964",
          sourceRunId: RUN,
          manifestId: MANIFEST,
          claimId: consumed.claimId,
          sourceEvidenceSha256: manifest.sourceEvidenceSha256,
          approvalSubjectSha256: manifest.approvalSubjectSha256,
          payloadSha256: state.payloadSha256,
          exactReplay: replay.replayed,
          rollbackReplay: rollbackReplay.replayed,
          finalClaimState: state.claimState,
          legacyConnectionActive: state.legacyConnectionActive,
          targetConnectionCount: state.connectionCount,
          sanctionedPairRejection: "BINDING_CLAIM_HISTORY_EXISTS",
          sanctionedPairUnchanged: true,
          auditKeys: audits.rows.map((audit) => audit.auditKey),
        }),
      );
    } finally {
      if (pool) await pool.end();
      if (client) await client.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 90_000);
});

type SourceRow = { database: "auth" | "booking" | "pms"; table: string; data: object };

function sourceRows(fixture: FixtureIds): SourceRow[] {
  return [
    {
      database: "auth",
      table: "users",
      data: {
        id: fixture.user,
        email: `${fixture.label}@example.test`,
        name: `VAY-1964 ${fixture.label} Owner`,
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
        id: fixture.property,
        user_id: fixture.user,
        name: `VAY-1964 ${fixture.label}`,
        slug: fixture.label,
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
        id: fixture.legacyHotel,
        user_id: fixture.user,
        name: `VAY-1964 ${fixture.label}`,
        slug: `${fixture.label}-pms`,
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
        id: fixture.connection,
        hotel_id: fixture.legacyHotel,
        channex_property_id: fixture.externalProperty,
        is_active: true,
        raw_guest_payload: RAW_GUEST_PAYLOAD_SENTINEL,
        provider_api_key: PROVIDER_SECRET_SENTINEL,
      },
    },
  ];
}

async function seedSource(
  client: pg.Client,
  fixture: FixtureIds = PRIMARY_FIXTURE,
): Promise<SourceLedger> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id,environment,source_schema_revision,status,started_at,finished_at,duration_ms)
     VALUES($1,'staging',$2,'completed',$3,$3,0)`,
    [fixture.run, VAY_1350_INVENTORY_REVISION, SOURCE_TIME],
  );
  for (const row of sourceRows(fixture))
    await client.query(
      `INSERT INTO migration_source_${row.database}.snapshot_rows
         (run_id,snapshot_identifier,source_schema,source_table,row_ordinal,
          row_checksum_sha256,row_data)
       VALUES($1,$2,'public',$3,1,
              encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex'),$4::jsonb)`,
      [fixture.run, `snapshot-${row.database}`, row.table, JSON.stringify(row.data)],
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
        [fixture.run, sourceSchema, sourceTable],
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
      [
        fixture.run,
        database,
        `snapshot-${database}`,
        "f".repeat(32),
        sourceCount,
        aggregate,
        SOURCE_TIME,
      ],
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
        fixture.run,
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
      run_id: fixture.run,
      environment: "staging",
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

async function addCanonicalOwnership(client: pg.Client, fixture: FixtureIds = PRIMARY_FIXTURE) {
  const legacy = (
    await client.query<{ id: string; organizationId: string }>(
      `SELECT id::text,organization_id::text AS "organizationId"
         FROM identity.organization_resource_links
        WHERE product='pms' AND resource_type='pms_hotel' AND resource_id=$1`,
      [fixture.legacyHotel],
    )
  ).rows[0]!;
  const inserted = await client.query<{ id: string; product: string }>(
    `INSERT INTO identity.organization_resource_links
       (organization_id,product,resource_type,resource_id,relationship,status)
     VALUES($1,'hotel_catalog','property',$2,'owner','active'),
           ($1,'pms','pms_property',$2,'operator','active')
     RETURNING id::text,product`,
    [legacy.organizationId, fixture.property],
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
  fixture: FixtureIds = PRIMARY_FIXTURE,
): Promise<ChannexAdoptionManifest> {
  const sourceLinkId = (
    await client.query<{ id: string }>(
      `SELECT id::text FROM hotel_catalog.property_source_links
        WHERE source_system='pms' AND source_table='hotels' AND source_id=$1`,
      [fixture.legacyHotel],
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
    [fixture.run, ["hotels", "channex_connections"]],
  );
  const evidence = new Map(legacyRows.rows.map((row) => [row.sourceTable, row]));
  const targetRows = [];
  for (const [table, id] of [
    ["hotel_catalog.properties", fixture.property],
    ["hotel_catalog.property_source_links", sourceLinkId],
    ["identity.organization_resource_links", ownership.legacyResourceLinkId],
    ["identity.organization_resource_links", ownership.targetResourceLinkId],
    ["identity.organization_resource_links", ownership.targetPmsResourceLinkId],
    ["identity.organizations", ownership.organizationId],
  ] as const)
    targetRows.push(await readAdoptionTargetRow(client, table, id));
  const bindingClaimIds = await client.query<{ id: string }>(
    `SELECT id::text FROM pms.channel_binding_claims
      WHERE property_id=$1 OR (provider='channex' AND external_property_id=$2)
      ORDER BY id`,
    [fixture.property, fixture.externalProperty],
  );
  const bindingClaims = await Promise.all(
    bindingClaimIds.rows.map((row) =>
      readAdoptionTargetRow(client, "pms.channel_binding_claims", row.id),
    ),
  );
  const empty = (kind: Parameters<typeof hashOrderedSourceRows>[0]) => ({
    rowCount: 0,
    orderedRowsSha256: hashOrderedSourceRows(kind, []),
  });
  const manifest: ChannexAdoptionManifest = {
    contractVersion: "channex-property-adoption.v1",
    manifestId: fixture.manifest,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    environment: "staging",
    sourceEnvironment: "staging",
    sourceRunId: fixture.run,
    sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
    sourceEvidenceSha256: hashSourceLedger(ledger),
    legacyPmsHotelId: fixture.legacyHotel,
    externalPropertyId: fixture.externalProperty,
    targetPropertyId: fixture.property,
    targetOrganizationId: ownership.organizationId,
    targetSourceLinkId: sourceLinkId,
    legacyResourceLinkId: ownership.legacyResourceLinkId,
    targetResourceLinkId: ownership.targetResourceLinkId,
    targetPmsResourceLinkId: ownership.targetPmsResourceLinkId,
    legacyEvidence: {
      hotel: {
        rowOrdinal: Number(evidence.get("hotels")!.rowOrdinal),
        rowChecksumSha256: evidence.get("hotels")!.rowChecksumSha256,
        userId: fixture.user,
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
        migrationRunId: fixture.run,
        migrationPhase: "complete",
        migrationDisposition: "canonical",
      },
      legacyResourceLink: targetRows[2]!,
      targetResourceLink: targetRows[3]!,
      targetPmsResourceLink: targetRows[4]!,
      organization: targetRows[5]!,
      bindingClaims: {
        rowCount: bindingClaims.length,
        orderedRowsSha256: hashTargetBindingClaims(bindingClaims),
      },
    },
    approvalSubjectSha256: HASH,
    approvalEvidence: [
      approval(fixture.approvals[0], "migration_owner", 1),
      approval(fixture.approvals[1], "security_owner", 2),
    ],
    signingKeyId: "migration-staging-vay1964-ephemeral",
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
    approvedAt: APPROVED_AT,
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

type CliResult = { manifestId: string; claimId: string; replayed: boolean };

async function runCli(
  connectionString: string,
  command: "consume" | "rollback",
  configPath: string,
  args: string[],
): Promise<CliResult> {
  const { stdout } = await execFileAsync(
    "npm",
    ["run", "target:channex:adopt", "--", command, "--config", configPath, ...args],
    {
      cwd: REPOSITORY,
      encoding: "utf8",
      env: {
        ...process.env,
        TARGET_DATABASE_URL: connectionString,
        CHANNEX_ADOPTION_EXECUTION_PRINCIPAL: EXECUTION_PRINCIPAL,
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const result = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("{"));
  if (!result) throw new Error("Channex adoption CLI returned no JSON result");
  return JSON.parse(result) as CliResult;
}

async function expectCliFailure(
  operation: Promise<CliResult>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected Channex adoption CLI to reject with ${expectedCode}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Expected Channex adoption CLI"))
      throw error;
    expect(String((error as { stderr?: unknown }).stderr)).toContain(`Error: ${expectedCode}`);
  }
}

async function readPairState(client: pg.Client, fixture: FixtureIds) {
  const [claims, connections] = await Promise.all([
    client.query(
      `SELECT * FROM pms.channel_binding_claims
        WHERE property_id=$1 OR (provider='channex' AND external_property_id=$2) ORDER BY id`,
      [fixture.property, fixture.externalProperty],
    ),
    client.query(
      `SELECT * FROM pms.channel_connections
        WHERE property_id=$1 OR (provider='channex' AND external_property_id=$2) ORDER BY id`,
      [fixture.property, fixture.externalProperty],
    ),
  ]);
  return { claims: claims.rows, connections: connections.rows };
}

async function writeSignedManifest(
  directory: string,
  name: string,
  manifest: ChannexAdoptionManifest,
  privateKey: KeyObject,
): Promise<{ manifest: string; signature: string }> {
  const manifestPath = join(directory, `${name}.json`);
  const signaturePath = join(directory, `${name}.sig`);
  const signature = sign(null, Buffer.from(canonicalizeJson(manifest)), privateKey).toString(
    "base64url",
  );
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(signaturePath, signature, { mode: 0o600 });
  return { manifest: manifestPath, signature: signaturePath };
}

async function insertRollbackApprovals(
  client: pg.Client,
  manifest: ChannexAdoptionManifest,
  claimId: string,
  reason: string,
  expiresAt: string,
  ids: readonly [string, string],
): Promise<void> {
  const rollbackReasonSha256 = hashRollbackReason(reason);
  const rollbackSubjectSha256 = hashRollbackSubject({
    manifestId: manifest.manifestId,
    claimId,
    environment: manifest.environment,
    expiresAt,
    rollbackReasonSha256,
  });
  for (const [index, authority] of ["migration_owner", "security_owner"].entries())
    await client.query(
      `INSERT INTO platform.channex_adoption_rollback_approval_records
         (approval_record_id,manifest_id,environment,expires_at,rollback_reason_sha256,
          authority,actor_user_id,approved_at,rollback_subject_sha256,registry_revision,
          row_state_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ids[index],
        manifest.manifestId,
        manifest.environment,
        expiresAt,
        rollbackReasonSha256,
        authority,
        USER,
        APPROVED_AT,
        rollbackSubjectSha256,
        100 + index,
        HASH,
      ],
    );
}

function uuid(value: number): string {
  return `19630000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
