import {
  AskEvidenceUnavailableError,
  type AskEvidenceEntry,
  type AskEvidenceRepository,
  type AskEvidenceToolId,
} from "@vayada/domain-intelligence";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type AskEvidenceReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type TargetMetricEvidenceRow = QueryResultRow & {
  id: string;
  snapshotKey: string;
  sourceOwner: string;
  sourceView: string;
  product: string;
  requestedResourceId: string;
  resourceType: string;
  metricKey: string;
  generatedAt: Date | string | null;
  sourceFreshAt: Date | string | null;
  freshnessStatus: string;
  quality: string;
  sampleSize: number | string | null;
  aggregateId: string | null;
  valueSummary: unknown;
  filters: unknown;
};

type TargetSetupEvidenceRow = QueryResultRow & {
  id: string;
  snapshotKey: string;
  requestedResourceId: string;
  resourceType: string;
  setupArea: string;
  completionStatus: string;
  completenessScore: number | string;
  sourceSnapshotAt: Date | string | null;
  sourceFreshAt: Date | string | null;
  freshnessStatus: string;
  missingItems: unknown;
  blockingItems: unknown;
  staleItems: unknown;
  sourceFreshness: unknown;
};

const BOOKING_PERFORMANCE_METRIC_KEYS = new Set([
  "booking.direct_booking_share",
  "booking.gross_booking_revenue",
  "booking.average_daily_rate",
]);

export function createTargetAskEvidenceRepository(config: {
  connectionString: string;
  max?: number;
  pool?: AskEvidenceReadPool;
}): AskEvidenceRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Target Ask evidence repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: AskEvidenceReadPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async findMetricEvidence({ metricKeys, organizationId, resourceId, dateRange, filters }) {
      const toolIds = metricToolIds(metricKeys);
      if (toolIds.length === 0) return [];
      await ensureActiveCatalog(pool, toolIds);

      const result = await pool.query<TargetMetricEvidenceRow>(metricEvidenceSql(), [
        metricKeys,
        resourceId,
        organizationId,
        dateRange?.from ?? null,
        dateRange?.to ?? null,
        toolIds,
        JSON.stringify(filters),
      ]);

      return result.rows.map((row) => toMetricEvidence(row, dateRange, filters));
    },
    async findSetupEvidence({ toolId, organizationId, resourceId, filters }) {
      await ensureActiveCatalog(pool, [toolId]);
      const result = await pool.query<TargetSetupEvidenceRow>(setupEvidenceSql(), [
        resourceId,
        organizationId,
        toolId,
      ]);

      return result.rows.map((row) => toSetupEvidence(row, filters));
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

async function ensureActiveCatalog(
  pool: AskEvidenceReadPool,
  toolIds: AskEvidenceToolId[],
): Promise<void> {
  const result = await pool.query(
    `SELECT 1
     FROM intelligence.ai_evidence_catalog catalog
     WHERE catalog.tool_id = ANY($1::text[])
       AND catalog.tool_version = 'v1'
       AND catalog.status = 'active'
       AND catalog.read_only = TRUE
     LIMIT 1`,
    [toolIds],
  );
  if (result.rows.length === 0) {
    throw new AskEvidenceUnavailableError("source_not_in_catalog");
  }
}

function metricToolIds(metricKeys: string[]): AskEvidenceToolId[] {
  if (metricKeys.includes("booking.booking_source_mix")) return ["get_booking_source_mix"];
  if (metricKeys.some((metricKey) => BOOKING_PERFORMANCE_METRIC_KEYS.has(metricKey))) {
    return ["get_booking_performance"];
  }
  return [];
}

function metricEvidenceSql(): string {
  return `${bookingScopedPropertyCte()},
  active_catalog AS (
    SELECT DISTINCT catalog.source_owner, catalog.source_view, catalog.freshness_slo_seconds
    FROM intelligence.ai_evidence_catalog catalog
    WHERE catalog.tool_id = ANY($6::text[])
      AND catalog.tool_version = 'v1'
      AND catalog.status = 'active'
      AND catalog.read_only = TRUE
  ),
  ranked_snapshots AS (
    SELECT
      snapshot.*,
      scoped.resource_id AS requested_resource_id,
      scoped.resource_type AS requested_resource_type,
      catalog.freshness_slo_seconds,
      ROW_NUMBER() OVER (
        PARTITION BY snapshot.metric_key
        ORDER BY snapshot.generated_at DESC, snapshot.id DESC
      ) AS snapshot_rank
    FROM intelligence.metric_snapshot_runs snapshot
    JOIN scoped_property scoped ON scoped.property_id = snapshot.property_id
     AND snapshot.organization_id = $3::uuid
    JOIN active_catalog catalog
      ON catalog.source_owner = snapshot.source_owner
     AND catalog.source_view = snapshot.source_view
    WHERE snapshot.metric_key = ANY($1::text[])
      AND snapshot.run_status IN ('succeeded', 'partial', 'stale')
      AND ($4::date IS NULL OR snapshot.period_start = $4::date)
      AND ($5::date IS NULL OR snapshot.period_end = $5::date)
      AND ($7::jsonb = '{}'::jsonb OR snapshot.filters @> $7::jsonb)
  )
  SELECT
    id::text AS "id",
    snapshot_key AS "snapshotKey",
    source_owner AS "sourceOwner",
    source_view AS "sourceView",
    split_part(metric_key, '.', 1) AS "product",
    requested_resource_id AS "requestedResourceId",
    requested_resource_type AS "resourceType",
    metric_key AS "metricKey",
    generated_at AS "generatedAt",
    source_fresh_at AS "sourceFreshAt",
    CASE
      WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'stale'
      WHEN source_fresh_at IS NOT NULL
        AND source_fresh_at <= now() - (freshness_slo_seconds * interval '1 second')
        THEN 'stale'
      ELSE freshness_status
    END AS "freshnessStatus",
    quality,
    sample_size AS "sampleSize",
    aggregate_id AS "aggregateId",
    value_summary AS "valueSummary",
    filters
  FROM ranked_snapshots
  WHERE snapshot_rank = 1
  ORDER BY generated_at DESC`;
}

function setupEvidenceSql(): string {
  return `${setupScopedPropertyCte()},
  active_catalog AS (
    SELECT catalog.freshness_slo_seconds
    FROM intelligence.ai_evidence_catalog catalog
    WHERE catalog.tool_id = $3::text
      AND catalog.tool_version = 'v1'
      AND catalog.status = 'active'
      AND catalog.read_only = TRUE
    LIMIT 1
  ),
  ranked_setup AS (
    SELECT
      setup.*,
      scoped.resource_id AS requested_resource_id,
      scoped.resource_type AS requested_resource_type,
      catalog.freshness_slo_seconds,
      ROW_NUMBER() OVER (
        PARTITION BY setup.setup_area
        ORDER BY setup.source_snapshot_at DESC, setup.id DESC
      ) AS setup_rank
    FROM intelligence.setup_completeness_snapshots setup
    JOIN scoped_property scoped ON scoped.property_id = setup.property_id
     AND setup.organization_id = $2::uuid
    JOIN active_catalog catalog ON TRUE
    WHERE setup.completion_status <> 'not_applicable'
  )
  SELECT
    id::text AS "id",
    snapshot_key AS "snapshotKey",
    requested_resource_id AS "requestedResourceId",
    requested_resource_type AS "resourceType",
    setup_area AS "setupArea",
    completion_status AS "completionStatus",
    completeness_score AS "completenessScore",
    source_snapshot_at AS "sourceSnapshotAt",
    source_fresh_at AS "sourceFreshAt",
    CASE
      WHEN COALESCE(source_fresh_at, source_snapshot_at) <= now() - (freshness_slo_seconds * interval '1 second')
        THEN 'stale'
      ELSE freshness_status
    END AS "freshnessStatus",
    missing_items AS "missingItems",
    blocking_items AS "blockingItems",
    stale_items AS "staleItems",
    source_freshness AS "sourceFreshness"
  FROM ranked_setup
  WHERE setup_rank = 1
  ORDER BY
    CASE setup_area WHEN 'overall' THEN 0 ELSE 1 END,
    completeness_score ASC,
    setup_area ASC`;
}

function bookingScopedPropertyCte(): string {
  return `WITH scoped_property_candidates AS (
    SELECT
      property.id AS property_id,
      $2::text AS resource_id,
      'booking_hotel'::text AS resource_type,
      0 AS precedence
    FROM hotel_catalog.properties property
    WHERE property.id::text = $2
    UNION ALL
    SELECT
      source.property_id,
      source.source_id AS resource_id,
      'booking_hotel'::text AS resource_type,
      1 AS precedence
    FROM hotel_catalog.property_source_links source
    WHERE source.source_system = 'booking'
      AND source.source_table = 'booking_hotels'
      AND source.source_id = $2
      AND source.relationship = 'canonical_input'
      AND source.status = 'active'
  ),
  scoped_property AS (
    SELECT property_id, resource_id, resource_type
    FROM scoped_property_candidates
    ORDER BY precedence
    LIMIT 1
  )`;
}

function setupScopedPropertyCte(): string {
  return `WITH scoped_property_candidates AS (
    SELECT
      property.id AS property_id,
      $1::text AS resource_id,
      'booking_hotel'::text AS resource_type,
      0 AS precedence
    FROM hotel_catalog.properties property
    WHERE property.id::text = $1
    UNION ALL
    SELECT
      source.property_id,
      source.source_id AS resource_id,
      CASE
        WHEN source.source_system = 'pms' THEN 'pms_hotel'
        ELSE 'booking_hotel'
      END AS resource_type,
      CASE
        WHEN source.source_system = 'booking' THEN 1
        ELSE 2
      END AS precedence
    FROM hotel_catalog.property_source_links source
    WHERE source.source_id = $1
      AND source.status = 'active'
      AND (
        (
          source.source_system = 'booking'
          AND source.source_table = 'booking_hotels'
          AND source.relationship = 'canonical_input'
        )
        OR (
          source.source_system = 'pms'
          AND source.source_table = 'hotels'
          AND source.relationship = 'operational_input'
        )
      )
  ),
  scoped_property AS (
    SELECT property_id, resource_id, resource_type
    FROM scoped_property_candidates
    ORDER BY precedence
    LIMIT 1
  )`;
}

function toMetricEvidence(
  row: TargetMetricEvidenceRow,
  dateRange: AskEvidenceEntry["filters"]["dateRange"],
  filters: Record<string, unknown>,
): AskEvidenceEntry {
  const sampleSize = optionalNumber(row.sampleSize);
  return {
    evidenceId: `metric_${row.id}`,
    sourceOwner: row.sourceOwner,
    sourceView: row.sourceView,
    product: evidenceProduct(row.product),
    resourceId: row.requestedResourceId,
    resourceType: evidenceResourceType(row.resourceType),
    metricKey: row.metricKey,
    filters: mergeFilters(row.filters, filters, dateRange),
    freshness: freshness(row.freshnessStatus, row.sourceFreshAt ?? row.generatedAt),
    quality: evidenceQuality(row.quality),
    ...(sampleSize !== undefined ? { sampleSize } : {}),
    aggregateId: row.aggregateId ?? row.snapshotKey,
    valueSummary: objectValue(row.valueSummary),
  };
}

function toSetupEvidence(
  row: TargetSetupEvidenceRow,
  filters: Record<string, unknown>,
): AskEvidenceEntry {
  const missingItems = arrayValue(row.missingItems);
  const blockingItems = arrayValue(row.blockingItems);
  const staleItems = arrayValue(row.staleItems);
  const itemCount = missingItems.length + blockingItems.length + staleItems.length;
  return {
    evidenceId: `setup_${row.id}`,
    sourceOwner: "intelligence",
    sourceView: "setup_completeness_snapshots",
    product: "hotel_catalog",
    resourceId: row.requestedResourceId,
    resourceType: evidenceResourceType(row.resourceType),
    metricKey: "hotel_catalog.setup_completeness_score",
    filters: {
      ...filters,
      setupArea: row.setupArea,
    },
    freshness: freshness(row.freshnessStatus, row.sourceFreshAt ?? row.sourceSnapshotAt),
    quality: setupQuality(row),
    ...(itemCount > 0 ? { sampleSize: itemCount } : {}),
    aggregateId: row.snapshotKey,
    valueSummary: {
      setupArea: row.setupArea,
      completionStatus: row.completionStatus,
      completenessScore: Number(row.completenessScore),
      blockingArea: row.setupArea,
      blockingItem: firstItemLabel(blockingItems),
      missingItems,
      blockingItems,
      staleItems,
      sourceFreshness: objectValue(row.sourceFreshness),
    },
  };
}

function mergeFilters(
  storedFilters: unknown,
  requestFilters: Record<string, unknown>,
  dateRange: unknown,
): Record<string, unknown> {
  return {
    ...objectValue(storedFilters),
    ...requestFilters,
    ...(dateRange ? { dateRange } : {}),
  };
}

function evidenceProduct(value: string): AskEvidenceEntry["product"] {
  if (value === "booking" || value === "hotel_catalog" || value === "intelligence") {
    return value;
  }
  return "intelligence";
}

function evidenceResourceType(value: string): AskEvidenceEntry["resourceType"] {
  if (value === "pms_hotel") return "pms_hotel";
  return "booking_hotel";
}

function freshness(
  value: string,
  generatedAt: Date | string | null,
): AskEvidenceEntry["freshness"] {
  const status =
    value === "fresh" || value === "stale" || value === "unknown" || value === "unavailable"
      ? value
      : "unknown";
  const iso = toIsoDateTime(generatedAt);
  return iso ? { status, generatedAt: iso } : { status };
}

function evidenceQuality(value: string): AskEvidenceEntry["quality"] {
  switch (value) {
    case "complete":
    case "partial":
    case "stale":
    case "estimated":
    case "hotelier_entered":
    case "unavailable":
      return value;
    default:
      return "partial";
  }
}

function setupQuality(row: TargetSetupEvidenceRow): AskEvidenceEntry["quality"] {
  if (row.freshnessStatus === "stale" || row.completionStatus === "stale") return "stale";
  if (row.freshnessStatus === "unavailable") return "unavailable";
  if (row.completionStatus === "complete") return "complete";
  return "partial";
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function firstItemLabel(items: unknown[]): string | null {
  const first = items.find((item) => typeof item === "object" && item !== null);
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  return stringValue(record["label"]) ?? stringValue(record["itemKey"]);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
