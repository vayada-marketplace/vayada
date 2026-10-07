import pg from "pg";

type Queryable = Pick<pg.Pool, "query">;
type StoredOutcomeRow = {
  agreementId: string;
  outcome: unknown;
  sourceRevision: string;
  currentSourceRevision: string | null;
};

export type FinanceAffiliateEarningOutcome = {
  agreementId: string;
  status: "calculated" | "pending" | "needs_review";
  amount?: { commissionMinor: string; currency: string; currencyMinorUnit: number };
  adjustmentMinor?: string;
  freshness: "current" | "stale" | "unknown";
};

export async function readLatestAffiliateEarningOutcomes(
  database: Queryable,
  input: {
    agreementIds: string[];
    from: string;
    to: string;
    bookingKeys?: string[];
  },
): Promise<FinanceAffiliateEarningOutcome[]> {
  const result = await database.query<StoredOutcomeRow>(
    `WITH latest AS (
      SELECT DISTINCT ON(journal.property_id,journal.booking_id,journal.stay_item_id)
        journal.* FROM finance.affiliate_earning_journal journal
      ORDER BY journal.property_id,journal.booking_id,journal.stay_item_id,journal.revision DESC
    ), current_source AS (
      SELECT property_id,booking_id::text,stay_item_id::text,max(revision)::text AS revision
      FROM finance.affiliate_earning_reconciliation_revisions
      GROUP BY property_id,booking_id,stay_item_id
    ) SELECT latest.calculation_input#>>'{scope,agreementId}' AS "agreementId",latest.outcome,
      latest.source_revision::text AS "sourceRevision",current_source.revision AS "currentSourceRevision"
    FROM latest LEFT JOIN current_source USING(property_id,booking_id,stay_item_id)
    WHERE latest.calculation_input#>>'{scope,agreementId}'=ANY($1::text[])
      AND latest.recorded_at>=$2::timestamptz AND latest.recorded_at<$3::timestamptz
      AND ($4::text[] IS NULL OR latest.property_id::text||':'||latest.booking_id=ANY($4::text[]))`,
    [input.agreementIds, input.from, input.to, input.bookingKeys ?? null],
  );
  return result.rows.map(normalize);
}

function normalize(row: StoredOutcomeRow): FinanceAffiliateEarningOutcome {
  const outcome = parseOutcome(row.outcome);
  if (!outcome) throw new Error("Stored affiliate earning outcome is invalid");
  const freshness = !row.currentSourceRevision
    ? "unknown"
    : BigInt(row.currentSourceRevision) > BigInt(row.sourceRevision)
      ? "stale"
      : "current";
  return { agreementId: row.agreementId, ...outcome, freshness };
}

function parseOutcome(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.status === "pending") return { status: "pending" as const };
  if (row.status === "needs_review") return { status: "needs_review" as const };
  const snapshot = row.snapshot as
    | { commissionMinor?: unknown; scope?: { currency?: unknown; currencyMinorUnit?: unknown } }
    | undefined;
  if (
    row.status !== "calculated" ||
    !snapshot ||
    typeof snapshot.commissionMinor !== "string" ||
    !/^(0|[1-9]\d*)$/.test(snapshot.commissionMinor) ||
    typeof row.adjustmentMinor !== "string" ||
    !/^-?(0|[1-9]\d*)$/.test(row.adjustmentMinor) ||
    typeof snapshot.scope?.currency !== "string" ||
    !/^[A-Z]{3}$/.test(snapshot.scope.currency) ||
    !Number.isInteger(snapshot.scope.currencyMinorUnit)
  )
    return null;
  return {
    status: "calculated" as const,
    amount: {
      commissionMinor: snapshot.commissionMinor,
      currency: snapshot.scope.currency,
      currencyMinorUnit: snapshot.scope.currencyMinorUnit as number,
    },
    adjustmentMinor: row.adjustmentMinor,
  };
}
