import type { QueryResult, QueryResultRow } from "pg";

type QueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};
export type FinancialsActivationExpectation = "active" | "inactive";
type ReadinessRow = {
  propertyExists: boolean;
  pricingConfigured: boolean;
  missingCategories: number;
  eligibleBookings: number;
  assignmentCoverageGaps: number;
  missingRevenueLines: number;
  unresolvedRevenueLines: number;
  unknownAttributionBookings: number;
  otaSourceMismatches: number;
  otaLinesWithoutCommission: number;
  missingCommissionRules: number;
  ambiguousCommissionRules: number;
  pendingCommissionExpenses: number;
  financialsActive: boolean;
};
export type FinancialsActivationFinding = { code: string; count: number; message: string };

const REQUIRED_CATEGORIES = [
  "staff",
  "ota_commission",
  "utilities",
  "maintenance",
  "supplies",
  "marketing",
  "platform_fees",
] as const;

export const FINANCIALS_ACTIVATION_READINESS_SQL = `
WITH RECURSIVE
eligible AS (
  SELECT id,property_id,booking_channel,check_in,check_out,room_count
  FROM booking.guest_bookings
  WHERE property_id=$1::uuid AND lifecycle_status IN ('confirmed','completed')
),
revenue AS (
  SELECT evidence.*
  FROM booking.finance_nightly_revenue_evidence evidence
  WHERE evidence.property_id=$1::uuid
),
roots AS (
  SELECT * FROM revenue WHERE economic_event='room_night'
),
assignment_coverage AS (
  SELECT booking.id AS guest_booking_id,count(assignment.id)::int AS assignment_count,
    count(assignment.id) FILTER(WHERE assignment.stay_evidence_kind='exact')::int AS exact_count
  FROM eligible booking LEFT JOIN pms.operational_booking_assignments assignment
    ON assignment.guest_booking_id=booking.id AND assignment.property_id=booking.property_id
  GROUP BY booking.id
),
expected AS (
  SELECT booking.id AS guest_booking_id,assignment.position AS line_position,day::date AS stay_date
  FROM eligible booking
  JOIN pms.operational_booking_assignments assignment
    ON assignment.guest_booking_id=booking.id AND assignment.property_id=booking.property_id
   AND assignment.stay_evidence_kind='exact'
  CROSS JOIN LATERAL generate_series(assignment.check_in,assignment.check_out-1,interval '1 day') day
  UNION ALL
  SELECT booking.id,NULL,day::date
  FROM eligible booking
  CROSS JOIN LATERAL generate_series(booking.check_in,booking.check_out-1,interval '1 day') day
  JOIN assignment_coverage coverage ON coverage.guest_booking_id=booking.id
  WHERE coverage.exact_count=0
),
lineage AS (
  SELECT root.evidence_id AS root_id,root.evidence_id,root.gross_room_amount
  FROM roots root
  UNION ALL
  SELECT lineage.root_id,child.evidence_id,child.gross_room_amount
  FROM lineage
  JOIN revenue child ON child.corrects_evidence_id=lineage.evidence_id
),
effective_price AS (
  SELECT root_id,bool_or(gross_room_amount IS NOT NULL) AS resolved
  FROM lineage GROUP BY root_id
),
ota AS (
  SELECT root.evidence_id,root.source_kind,commission.snapshot_id,commission.evidence_state,
    commission.commission_amount
  FROM revenue root
  JOIN booking.finance_booking_attribution attribution
    ON attribution.guest_booking_id=root.guest_booking_id
   AND attribution.property_id=root.property_id
  LEFT JOIN finance.ota_commission_reporting_evidence commission
    ON commission.booking_revenue_evidence_id=root.evidence_id
   AND commission.property_id=root.property_id
  WHERE attribution.booking_channel IN ('booking_com','airbnb','expedia','agoda','other_ota')
)
SELECT
  EXISTS(SELECT 1 FROM hotel_catalog.properties WHERE id=$1::uuid) AS "propertyExists",
  EXISTS(SELECT 1 FROM pms.property_pricing_settings WHERE property_id=$1::uuid) AS "pricingConfigured",
  $2::int-(SELECT count(*)::int FROM finance.expense_categories
    WHERE property_id=$1::uuid AND archived_at IS NULL AND system_key=ANY($3::text[])) AS "missingCategories",
  (SELECT count(*)::int FROM eligible) AS "eligibleBookings",
  (SELECT count(*)::int FROM eligible booking JOIN assignment_coverage coverage
    ON coverage.guest_booking_id=booking.id WHERE coverage.assignment_count<>booking.room_count
      OR (booking.room_count>1 AND coverage.exact_count<>booking.room_count)) AS "assignmentCoverageGaps",
  (SELECT count(*)::int FROM expected night WHERE NOT EXISTS(SELECT 1 FROM roots
    WHERE guest_booking_id=night.guest_booking_id AND stay_date=night.stay_date
      AND (night.line_position IS NULL OR line_position=night.line_position))) AS "missingRevenueLines",
  (SELECT count(*)::int FROM effective_price WHERE NOT resolved) AS "unresolvedRevenueLines",
  (SELECT count(*)::int FROM eligible WHERE booking_channel='unknown') AS "unknownAttributionBookings",
  (SELECT count(*)::int FROM ota WHERE source_kind<>'ota') AS "otaSourceMismatches",
  (SELECT count(*)::int FROM ota WHERE snapshot_id IS NULL) AS "otaLinesWithoutCommission",
  (SELECT count(*)::int FROM ota WHERE evidence_state LIKE 'missing_rule%') AS "missingCommissionRules",
  (SELECT count(*)::int FROM ota WHERE evidence_state LIKE 'ambiguous_rule%') AS "ambiguousCommissionRules",
  (SELECT count(*)::int FROM ota WHERE evidence_state='applied' AND commission_amount<>0
    AND NOT EXISTS(SELECT 1 FROM finance.expenses expense
      WHERE expense.property_id=$1::uuid AND expense.origin='ota_commission'
        AND (expense.source_key='ota_commission_evidence:'||ota.snapshot_id::text
          OR expense.source_key LIKE 'ota_commission_evidence:'||ota.snapshot_id::text||':%'))
  ) AS "pendingCommissionExpenses",
  EXISTS(SELECT 1 FROM identity.product_entitlements financials
    JOIN identity.organizations organization ON organization.id=financials.organization_id
      AND organization.kind='hotel_group' AND organization.status='active'
    JOIN identity.organization_resource_links resource
      ON resource.organization_id=financials.organization_id AND resource.product='pms'
     AND resource.resource_type='pms_property' AND resource.resource_id=$1::text
     AND resource.relationship IN ('owner','finance_manager') AND resource.status='active'
    WHERE financials.product='pms' AND financials.entitlement_key='module:financials'
      AND financials.status='active' AND (financials.resource_product IS NULL OR
        (financials.resource_product='pms' AND financials.resource_type='pms_property'
          AND financials.resource_id=$1::text))
      AND (financials.starts_at IS NULL OR financials.starts_at<=now())
      AND (financials.expires_at IS NULL OR financials.expires_at>now())
      AND NOT EXISTS(SELECT 1 FROM identity.product_entitlements suspended
        WHERE suspended.organization_id=financials.organization_id AND suspended.product='pms'
          AND suspended.entitlement_key='module:financials' AND suspended.status='suspended'
          AND (suspended.starts_at IS NULL OR suspended.starts_at<=now())
          AND (suspended.expires_at IS NULL OR suspended.expires_at>now())
          AND (suspended.resource_product IS NULL OR (suspended.resource_product='pms'
            AND suspended.resource_type='pms_property' AND suspended.resource_id=$1::text)))
      AND EXISTS(SELECT 1 FROM identity.product_entitlements base
        WHERE base.organization_id=financials.organization_id AND base.product='pms'
          AND base.entitlement_key='property-management' AND base.status='active'
          AND (base.starts_at IS NULL OR base.starts_at<=now())
          AND (base.expires_at IS NULL OR base.expires_at>now())
          AND (base.resource_product IS NULL OR (base.resource_product='pms'
            AND base.resource_type='pms_property' AND base.resource_id=$1::text)))
      AND NOT EXISTS(SELECT 1 FROM identity.product_entitlements suspended
        WHERE suspended.organization_id=financials.organization_id AND suspended.product='pms'
          AND suspended.entitlement_key='property-management' AND suspended.status='suspended'
          AND (suspended.starts_at IS NULL OR suspended.starts_at<=now())
          AND (suspended.expires_at IS NULL OR suspended.expires_at>now())
          AND (suspended.resource_product IS NULL OR (suspended.resource_product='pms'
            AND suspended.resource_type='pms_property' AND suspended.resource_id=$1::text))))
    AS "financialsActive"`;

export async function runFinancialsActivationReadiness(
  client: QueryExecutor,
  input: { propertyId: string; expectedModuleState?: FinancialsActivationExpectation; now?: Date },
) {
  if (!UUID.test(input.propertyId))
    throw new Error("Financials readiness property ID is malformed");
  const transaction = await client.query<{ transaction_read_only: string }>(
    "SHOW transaction_read_only",
  );
  if (transaction.rows[0]?.transaction_read_only !== "on")
    throw new Error("Financials activation readiness requires a read-only transaction");
  const row = (
    await client.query<ReadinessRow>(FINANCIALS_ACTIVATION_READINESS_SQL, [
      input.propertyId.toLowerCase(),
      REQUIRED_CATEGORIES.length,
      REQUIRED_CATEGORIES,
    ])
  ).rows[0];
  if (!row) throw new Error("Financials activation readiness returned no result");
  const findings: FinancialsActivationFinding[] = [];
  const add = (code: string, count: number, message: string) => {
    if (count > 0) findings.push({ code, count, message });
  };
  add("PROPERTY_NOT_FOUND", row.propertyExists ? 0 : 1, "The target property does not exist.");
  add("PRICING_NOT_CONFIGURED", row.pricingConfigured ? 0 : 1, "Property currency is unavailable.");
  add(
    "DEFAULT_CATEGORIES_MISSING",
    row.missingCategories,
    "Required default expense categories are missing or archived.",
  );
  add(
    "STAY_SCOPE_INCOMPLETE",
    row.assignmentCoverageGaps,
    "Eligible bookings lack assignment coverage required to prove room-night scope.",
  );
  add(
    "REVENUE_BACKFILL_INCOMPLETE",
    row.missingRevenueLines,
    "Eligible booking nights are missing nightly revenue projections.",
  );
  add(
    "REVENUE_EVIDENCE_MISSING",
    row.unresolvedRevenueLines,
    "Nightly revenue remains unresolved after corrections.",
  );
  add(
    "ATTRIBUTION_UNKNOWN",
    row.unknownAttributionBookings,
    "Eligible bookings have unknown channel attribution.",
  );
  add(
    "OTA_REVENUE_SOURCE_MISMATCH",
    row.otaSourceMismatches,
    "OTA-attributed revenue lines are not classified as OTA evidence.",
  );
  add(
    "OTA_COMMISSION_EVIDENCE_MISSING",
    row.otaLinesWithoutCommission,
    "OTA revenue lines have no commission snapshot.",
  );
  add(
    "OTA_COMMISSION_RULE_MISSING",
    row.missingCommissionRules,
    "OTA commission snapshots have no effective rule.",
  );
  add(
    "OTA_COMMISSION_RULE_AMBIGUOUS",
    row.ambiguousCommissionRules,
    "OTA commission snapshots match multiple rules.",
  );
  add(
    "OTA_COMMISSION_EXPENSE_PENDING",
    row.pendingCommissionExpenses,
    "Applied OTA commissions are not materialized as expenses.",
  );
  const expected = input.expectedModuleState ?? "inactive";
  add(
    "MODULE_STATE_MISMATCH",
    row.financialsActive === (expected === "active") ? 0 : 1,
    `Financials must be ${expected} for this readiness gate.`,
  );
  return {
    contractVersion: "pms-financials-activation-readiness.v1" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
    propertyId: input.propertyId.toLowerCase(),
    expectedModuleState: expected,
    actualModuleState: row.financialsActive ? ("active" as const) : ("inactive" as const),
    status: findings.length ? ("blocked" as const) : ("ready" as const),
    summary: { ...row, blockers: findings.reduce((total, finding) => total + finding.count, 0) },
    findings,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
