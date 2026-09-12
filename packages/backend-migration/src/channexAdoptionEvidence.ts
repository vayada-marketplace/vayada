import type pg from "pg";

import type { ChannexAdoptionManifest } from "./channexAdoptionManifest.js";
import { rejectAdoption } from "./channexAdoptionConsumptionError.js";
import {
  canonicalizeJson,
  hashExpectedDatabaseName,
  hashOrderedSourceRows,
  hashSnapshotIdentifier,
  hashSourceLedger,
  hashTargetBindingClaims,
  type SourceLedger,
} from "./channexAdoptionManifestCrypto.js";
import { readAdoptionTargetRow } from "./channexAdoptionTargetRows.js";
import { buildProductionCatalogPlan } from "./productionCatalogPlan.js";
import { planCatalogOwnership, type CatalogOwnerLink } from "./productionCatalogOwnership.js";
import { readProductionCatalogSnapshot } from "./productionCatalogSnapshotReader.js";
import {
  readProductionCatalogSourceLinks,
  readProductionCatalogTargetState,
} from "./productionCatalogTargetReader.js";
import { buildProductionIdentityPlan } from "./productionIdentityPlan.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";
import { readProductionIdentityTargetState } from "./productionIdentityTargetReader.js";
import { readProductionPmsSnapshot } from "./productionPmsSnapshotReader.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type EvidenceRow = {
  rowOrdinal: string;
  rowChecksumSha256: string;
  rowData: Record<string, unknown>;
};

export async function verifyChannexAdoptionSourceEvidence(
  client: QueryClient,
  manifest: ChannexAdoptionManifest,
): Promise<void> {
  const identitySnapshot = await readProductionIdentitySnapshot(client, manifest.sourceRunId);
  const ledger = await readSourceLedger(client, manifest.sourceRunId);
  assertEqual(ledger.run.environment, manifest.sourceEnvironment, "SOURCE_ENVIRONMENT_MISMATCH");
  assertEqual(
    ledger.run.source_schema_revision,
    manifest.sourceSchemaRevision,
    "SOURCE_REVISION_MISMATCH",
  );
  assertEqual(hashSourceLedger(ledger), manifest.sourceEvidenceSha256, "SOURCE_LEDGER_MISMATCH");

  await readProductionPmsSnapshot(client, manifest.sourceRunId, {
    validateRun: async () => identitySnapshot,
  });
  const rows = await readLegacyRows(client, manifest.sourceRunId);
  const connections = rows.channex_connections.filter(
    (row) =>
      row.rowData["channex_property_id"] === manifest.externalPropertyId &&
      row.rowData["is_active"] === true,
  );
  if (connections.length !== 1) rejectAdoption("LEGACY_CONNECTION_MISMATCH");
  const connection = connections[0]!;
  assertEqual(
    connection.rowData["hotel_id"],
    manifest.legacyPmsHotelId,
    "LEGACY_CONNECTION_MISMATCH",
  );
  assertRowEvidence(connection, manifest.legacyEvidence.connection, "LEGACY_CONNECTION_MISMATCH");

  const hotels = rows.hotels.filter((row) => row.rowData["id"] === manifest.legacyPmsHotelId);
  if (hotels.length !== 1) rejectAdoption("LEGACY_HOTEL_MISMATCH");
  const hotel = hotels[0]!;
  assertEqual(
    hotel.rowData["user_id"],
    manifest.legacyEvidence.hotel.userId,
    "LEGACY_HOTEL_MISMATCH",
  );
  assertRowEvidence(hotel, manifest.legacyEvidence.hotel, "LEGACY_HOTEL_MISMATCH");

  const roomTypes = ownedRows(rows.channex_room_type_mappings, manifest.legacyPmsHotelId);
  const ratePlans = ownedRows(rows.channex_rate_plan_mappings, manifest.legacyPmsHotelId);
  const bookingMappings = ownedRows(rows.channex_booking_mappings, manifest.legacyPmsHotelId);
  const bookingIds = new Set(bookingMappings.map((row) => requiredUuid(row.rowData["booking_id"])));
  const bookings = rows.bookings.filter((row) => bookingIds.has(requiredUuid(row.rowData["id"])));
  if (bookings.length !== bookingIds.size) rejectAdoption("LEGACY_BOOKING_MISMATCH");
  for (const booking of bookings)
    assertEqual(booking.rowData["hotel_id"], manifest.legacyPmsHotelId, "LEGACY_BOOKING_MISMATCH");

  assertAggregate(
    "pms-channex-room-type-mappings",
    roomTypes,
    manifest.legacyEvidence.roomTypeMappings,
  );
  assertAggregate(
    "pms-channex-rate-plan-mappings",
    ratePlans,
    manifest.legacyEvidence.ratePlanMappings,
  );
  assertAggregate(
    "pms-channex-booking-mappings",
    bookingMappings,
    manifest.legacyEvidence.bookingMappings,
  );
  assertAggregate("pms-bookings", bookings, manifest.legacyEvidence.bookings);
}

export async function verifyChannexAdoptionTargetEvidence(
  client: QueryClient,
  manifest: ChannexAdoptionManifest,
): Promise<void> {
  const identitySnapshot = await readProductionIdentitySnapshot(client, manifest.sourceRunId);
  const identityTarget = await readProductionIdentityTargetState(client, identitySnapshot.rows);
  const identityPlan = buildProductionIdentityPlan(
    identitySnapshot.rows,
    identityTarget,
    identitySnapshot.sourceHorizonAt,
  );
  if (identityPlan.blockers.length) rejectAdoption("IDENTITY_PLAN_BLOCKED");
  if (identityPlan.quarantinedOrganizations || identityPlan.quarantinedResourceLinks)
    rejectAdoption("IDENTITY_PLAN_WARNINGS");

  const catalogRows = await readProductionCatalogSnapshot(client, manifest.sourceRunId, {
    validateRun: async () => identitySnapshot,
  });
  const sourceLinks = await readProductionCatalogSourceLinks(client);
  const ownerLinks = await readCatalogOwnerLinks(client);
  const ownership = planCatalogOwnership(catalogRows, sourceLinks, ownerLinks);
  if (ownership.blockers.length) rejectAdoption("CATALOG_PLAN_BLOCKED");
  const propertyIds = ownership.properties.map((row) => row.propertyId);
  const catalogTarget = await readProductionCatalogTargetState(
    client,
    propertyIds,
    manifest.sourceRunId,
  );
  const catalogPlan = buildProductionCatalogPlan(catalogRows, catalogTarget);
  if (catalogPlan.blockers.length) rejectAdoption("CATALOG_PLAN_BLOCKED");
  if (catalogPlan.quarantinedSources.length) rejectAdoption("CATALOG_PLAN_WARNINGS");

  const plannedSourceLinks = catalogPlan.sourceLinks.filter(
    (row) =>
      row.sourceSystem === "pms" &&
      row.sourceTable === "hotels" &&
      row.sourceId === manifest.legacyPmsHotelId,
  );
  if (plannedSourceLinks.length !== 1) rejectAdoption("TARGET_SOURCE_LINK_MISMATCH");
  const plannedSourceLink = plannedSourceLinks[0]!;
  assertEqual(plannedSourceLink.propertyId, manifest.targetPropertyId, "TARGET_PROPERTY_MISMATCH");
  if (
    plannedSourceLink.relationship !== "operational_input" ||
    plannedSourceLink.migrationDisposition !== "canonical" ||
    plannedSourceLink.migrationDispositionReason !== null
  )
    rejectAdoption("TARGET_SOURCE_LINK_MISMATCH");
  await assertSourceLink(client, manifest);

  const plannedLegacyLinks = identityPlan.resourceLinks.filter(
    (row) =>
      row.product === "pms" &&
      row.resourceType === "pms_hotel" &&
      row.resourceId === manifest.legacyPmsHotelId &&
      row.relationship === "operator" &&
      row.status === "active",
  );
  if (
    plannedLegacyLinks.length !== 1 ||
    plannedLegacyLinks[0]!.organizationId !== manifest.targetOrganizationId
  )
    rejectAdoption("LEGACY_OWNERSHIP_MISMATCH");
  await assertResourceLink(client, manifest.legacyResourceLinkId, {
    organizationId: manifest.targetOrganizationId,
    product: "pms",
    resourceType: "pms_hotel",
    resourceId: manifest.legacyPmsHotelId,
    relationship: "operator",
  });
  await assertCanonicalOwnership(client, manifest);
  await assertOrganization(client, manifest);
  await assertTargetHashes(client, manifest);
  await assertBindingClaims(client, manifest);
}

async function readSourceLedger(client: QueryClient, runId: string): Promise<SourceLedger> {
  const run = await client.query<SourceLedger["run"]>(
    `SELECT run_id, environment, source_schema_revision, cutover_freeze_proof_sha256, status,
            to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at
       FROM platform.source_extraction_runs WHERE run_id = $1`,
    [runId],
  );
  if (run.rows.length !== 1 || run.rows[0]!.status !== "completed")
    rejectAdoption("SOURCE_RUN_MISMATCH");
  const sources = await client.query<
    Omit<
      SourceLedger["sources"][number],
      "snapshot_identifier_sha256" | "expected_database_name_sha256" | "row_count"
    > & {
      snapshot_identifier: string;
      expected_database_name: string;
      row_count: string;
    }
  >(
    `SELECT source_database, snapshot_identifier, expected_database_name,
            expected_schema_fingerprint, actual_schema_fingerprint, status, row_count::text,
            checksum_sha256,
            to_char(source_snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_snapshot_at
       FROM platform.source_extraction_sources WHERE run_id = $1 ORDER BY source_database`,
    [runId],
  );
  const tables = await client.query<
    Omit<SourceLedger["tables"][number], "row_count"> & { row_count: string }
  >(
    `SELECT source_database, source_schema, source_table, status, row_count::text, checksum_sha256
       FROM platform.source_extraction_tables WHERE run_id = $1
       ORDER BY source_database, source_schema, source_table`,
    [runId],
  );
  return {
    run: run.rows[0]!,
    sources: sources.rows.map(
      ({ snapshot_identifier, expected_database_name, row_count, ...row }) => ({
        ...row,
        snapshot_identifier_sha256: hashSnapshotIdentifier(snapshot_identifier),
        expected_database_name_sha256: hashExpectedDatabaseName(expected_database_name),
        row_count: parseCount(row_count),
      }),
    ),
    tables: tables.rows.map(({ row_count, ...row }) => ({
      ...row,
      row_count: parseCount(row_count),
    })),
  };
}

async function readLegacyRows(client: QueryClient, runId: string) {
  const tables = [
    "hotels",
    "channex_connections",
    "channex_room_type_mappings",
    "channex_rate_plan_mappings",
    "channex_booking_mappings",
    "bookings",
  ] as const;
  const result = await client.query<EvidenceRow & { sourceTable: (typeof tables)[number] }>(
    `SELECT source_table AS "sourceTable", row_ordinal::text AS "rowOrdinal",
            row_checksum_sha256 AS "rowChecksumSha256", row_data AS "rowData"
       FROM migration_source_pms.snapshot_rows
      WHERE run_id = $1 AND source_schema = 'public' AND source_table = ANY($2::text[])
      ORDER BY source_table, row_ordinal`,
    [runId, tables],
  );
  return Object.fromEntries(
    tables.map((table) => [table, result.rows.filter((row) => row.sourceTable === table)]),
  ) as unknown as Record<(typeof tables)[number], EvidenceRow[]>;
}

async function readCatalogOwnerLinks(client: QueryClient): Promise<CatalogOwnerLink[]> {
  const result = await client.query<CatalogOwnerLink>(
    `SELECT organization_id::text AS "organizationId", product,
            resource_type AS "resourceType", resource_id AS "resourceId", relationship, status
       FROM identity.organization_resource_links
      WHERE (product, resource_type, relationship) IN (
        ('booking', 'booking_hotel', 'owner'),
        ('pms', 'pms_hotel', 'operator'),
        ('marketplace', 'hotel_profile', 'owner'))
      ORDER BY product, resource_type, resource_id, relationship, organization_id`,
  );
  return result.rows;
}

async function assertSourceLink(client: QueryClient, manifest: ChannexAdoptionManifest) {
  const result = await client.query<{
    propertyId: string;
    sourceSystem: string;
    sourceTable: string;
    sourceId: string;
    relationship: string;
    status: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT property_id::text AS "propertyId", source_system AS "sourceSystem",
            source_table AS "sourceTable", source_id AS "sourceId", relationship, status, metadata
       FROM hotel_catalog.property_source_links WHERE id = $1::uuid`,
    [manifest.targetSourceLinkId],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.propertyId !== manifest.targetPropertyId ||
    row.sourceSystem !== "pms" ||
    row.sourceTable !== "hotels" ||
    row.sourceId !== manifest.legacyPmsHotelId ||
    row.relationship !== "operational_input" ||
    row.status !== "active" ||
    canonicalizeJson(row.metadata) !==
      canonicalizeJson({
        migrationRunId: manifest.sourceRunId,
        migrationPhase: "complete",
        migrationDisposition: "canonical",
        migrationDispositionReason: null,
      })
  )
    rejectAdoption("TARGET_SOURCE_LINK_MISMATCH");
}

async function assertCanonicalOwnership(client: QueryClient, manifest: ChannexAdoptionManifest) {
  const result = await client.query<{
    id: string;
    organizationId: string;
    product: string;
    resourceType: string;
    resourceId: string;
    relationship: string;
    status: string;
  }>(
    `SELECT id::text, organization_id::text AS "organizationId", product,
            resource_type AS "resourceType", resource_id AS "resourceId", relationship, status
       FROM identity.organization_resource_links
      WHERE status = 'active' AND resource_id = $1
        AND ((product = 'hotel_catalog' AND resource_type = 'property' AND relationship IN ('owner', 'operator'))
          OR (product = 'pms' AND resource_type = 'pms_property' AND relationship IN ('owner', 'operator')))
      ORDER BY product, id`,
    [manifest.targetPropertyId],
  );
  const canonical = result.rows.filter((row) => row.product === "hotel_catalog");
  const pms = result.rows.filter((row) => row.product === "pms");
  if (
    canonical.length !== 1 ||
    pms.length !== 1 ||
    canonical[0]!.id !== manifest.targetResourceLinkId ||
    pms[0]!.id !== manifest.targetPmsResourceLinkId ||
    canonical[0]!.organizationId !== manifest.targetOrganizationId ||
    pms[0]!.organizationId !== manifest.targetOrganizationId
  )
    rejectAdoption("TARGET_OWNERSHIP_MISMATCH");
}

async function assertResourceLink(
  client: QueryClient,
  id: string,
  expected: {
    organizationId: string;
    product: string;
    resourceType: string;
    resourceId: string;
    relationship: string;
  },
) {
  const result = await client.query<typeof expected & { status: string }>(
    `SELECT organization_id::text AS "organizationId", product,
            resource_type AS "resourceType", resource_id AS "resourceId", relationship, status
       FROM identity.organization_resource_links WHERE id = $1::uuid`,
    [id],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row?.status !== "active")
    rejectAdoption("TARGET_OWNERSHIP_MISMATCH");
  for (const [key, value] of Object.entries(expected))
    assertEqual(row?.[key as keyof typeof expected], value, "TARGET_OWNERSHIP_MISMATCH");
}

async function assertOrganization(client: QueryClient, manifest: ChannexAdoptionManifest) {
  const result = await client.query<{ kind: string; status: string }>(
    `SELECT kind, status FROM identity.organizations WHERE id = $1::uuid`,
    [manifest.targetOrganizationId],
  );
  if (
    result.rows.length !== 1 ||
    result.rows[0]?.kind !== "hotel_group" ||
    result.rows[0].status !== "active"
  )
    rejectAdoption("TARGET_ORGANIZATION_MISMATCH");
}

async function assertTargetHashes(client: QueryClient, manifest: ChannexAdoptionManifest) {
  const evidence = manifest.targetEvidence;
  const rows = [];
  for (const [table, id] of [
    ["hotel_catalog.properties", manifest.targetPropertyId],
    ["hotel_catalog.property_source_links", manifest.targetSourceLinkId],
    ["identity.organization_resource_links", manifest.legacyResourceLinkId],
    ["identity.organization_resource_links", manifest.targetResourceLinkId],
    ["identity.organization_resource_links", manifest.targetPmsResourceLinkId],
    ["identity.organizations", manifest.targetOrganizationId],
  ] as const)
    rows.push(await readAdoptionTargetRow(client, table, id));
  const signed = [
    evidence.property,
    evidence.sourceLink,
    evidence.legacyResourceLink,
    evidence.targetResourceLink,
    evidence.targetPmsResourceLink,
    evidence.organization,
  ];
  rows.forEach((row, index) => {
    if (row.id !== signed[index]!.id || row.rowStateSha256 !== signed[index]!.rowStateSha256)
      rejectAdoption("TARGET_ROW_HASH_MISMATCH");
  });
}

async function assertBindingClaims(client: QueryClient, manifest: ChannexAdoptionManifest) {
  const result = await client.query<{ id: string }>(
    `SELECT id::text FROM pms.channel_binding_claims
      WHERE property_id = $1::uuid OR (provider = 'channex' AND external_property_id = $2)
      ORDER BY id`,
    [manifest.targetPropertyId, manifest.externalPropertyId],
  );
  const rows = [];
  for (const row of result.rows)
    rows.push(await readAdoptionTargetRow(client, "pms.channel_binding_claims", row.id));
  const signed = manifest.targetEvidence.bindingClaims;
  if (rows.length !== signed.rowCount || hashTargetBindingClaims(rows) !== signed.orderedRowsSha256)
    rejectAdoption("BINDING_CLAIM_EVIDENCE_MISMATCH");
  if (rows.length !== 0) rejectAdoption("BINDING_CLAIM_HISTORY_EXISTS");
}

function ownedRows(rows: EvidenceRow[], hotelId: string): EvidenceRow[] {
  const owned = rows.filter((row) => row.rowData["hotel_id"] === hotelId);
  for (const row of owned) assertEqual(row.rowData["hotel_id"], hotelId, "LEGACY_MAPPING_MISMATCH");
  return owned;
}

function assertAggregate(
  kind: Parameters<typeof hashOrderedSourceRows>[0],
  rows: EvidenceRow[],
  expected: { rowCount: number; orderedRowsSha256: string },
) {
  if (
    rows.length !== expected.rowCount ||
    hashOrderedSourceRows(
      kind,
      rows.map((row) => ({
        rowOrdinal: parseCount(row.rowOrdinal),
        rowChecksumSha256: row.rowChecksumSha256,
      })),
    ) !== expected.orderedRowsSha256
  )
    rejectAdoption("LEGACY_AGGREGATE_MISMATCH");
}

function assertRowEvidence(
  actual: EvidenceRow,
  expected: { rowOrdinal: number; rowChecksumSha256: string },
  code: string,
) {
  if (
    parseCount(actual.rowOrdinal) !== expected.rowOrdinal ||
    actual.rowChecksumSha256 !== expected.rowChecksumSha256
  )
    rejectAdoption(code);
}

function requiredUuid(value: unknown): string {
  if (typeof value !== "string") rejectAdoption("LEGACY_ROW_MISMATCH");
  return value.toLowerCase();
}

function parseCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) rejectAdoption("INVALID_EVIDENCE_COUNT");
  return parsed;
}

function assertEqual(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) rejectAdoption(code);
}
