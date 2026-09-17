import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  normalizeFinanceReportingDecimal,
  parseFinanceRevenueQuery,
  type FinanceReportingComparison,
  type FinanceReportingMoney,
} from "@vayada/domain-finance";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};
export type FinanceRevenueRoomFactsPool = Pick<Client, "query"> & {
  connect(): Promise<Client>;
  end?(): Promise<void>;
};
export type FinanceRevenueRoomFactsClient = Pick<Client, "query">;
export type FinanceRevenueRoomFact = {
  period: "current" | "comparison";
  recognizedOn: string;
  channel: string;
  directSource: string | null;
  roomTypeId: string;
  grossRoomAmount: string;
  otaCommissionAmount: string;
  occupiedRoomNights: number;
  pricedOccupiedRoomNights: number;
};
export type FinanceRevenueRoomGap =
  | {
      code: "room_revenue_currency_mismatch";
      count: number;
      currency: string;
      amount?: FinanceReportingMoney;
    }
  | { code: "room_revenue_missing" | "ota_commission_missing"; count: number };
export type FinanceRevenueRoomFacts = {
  rows: FinanceRevenueRoomFact[];
  eligibleBookings: { current: number; comparison: number };
  sourceFreshness: {
    bookingRevenueThrough: string | null;
    financeOtaCommissionAt: string | null;
  };
  incompleteEvidence: FinanceRevenueRoomGap[];
};
export type FinanceRevenueRoomFactsInput = {
  propertyId: string;
  currency: string;
  periods: FinanceReportingComparison;
};
export type FinanceRevenueRoomFactsReadPort = {
  read(input: FinanceRevenueRoomFactsInput): Promise<FinanceRevenueRoomFacts>;
  close(): Promise<void>;
};

type FactRow = Omit<FinanceRevenueRoomFact, "period"> & {
  period: string;
  bookingRevenueThrough: string | null;
  financeOtaCommissionAt: string | null;
};
type GapRow = {
  code: FinanceRevenueRoomGap["code"];
  count: number;
  amount: string | null;
  currency: string | null;
};
type EligibleRow = { period: string; count: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgFinanceRevenueRoomFacts(config: {
  connectionString?: string;
  pool?: FinanceRevenueRoomFactsPool;
  max?: number;
}): FinanceRevenueRoomFactsReadPort {
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Finance revenue room facts require a connection string");
  const ownsPool = !config.pool;
  const pool: FinanceRevenueRoomFactsPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async read(input) {
      return consistentRead(pool, (client) => readFinanceRevenueRoomFacts(client, input));
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

export async function readFinanceRevenueRoomFacts(
  client: FinanceRevenueRoomFactsClient,
  input: FinanceRevenueRoomFactsInput,
): Promise<FinanceRevenueRoomFacts> {
  const propertyId = uuid(input.propertyId);
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new TypeError("Finance revenue currency is malformed");
  const current = parseFinanceRevenueQuery(input.periods.current);
  const comparison = parseFinanceRevenueQuery(input.periods.comparison);
  if (!current || !comparison || comparison.to >= current.from)
    throw new TypeError("Finance revenue comparison periods are malformed");
  const values = [
    propertyId,
    input.currency,
    current.from,
    current.to,
    comparison.from,
    comparison.to,
  ];
  const rows = await readFacts(client, values);
  return {
    rows: rows.map(fact),
    eligibleBookings: await readEligibleBookings(client, values),
    sourceFreshness: {
      bookingRevenueThrough: rows[0]?.bookingRevenueThrough ?? null,
      financeOtaCommissionAt: instant(rows[0]?.financeOtaCommissionAt ?? null),
    },
    incompleteEvidence: (await readGaps(client, values)).map(gap),
  };
}

const SCOPED = `WITH RECURSIVE selected AS (SELECT revenue.*,attribution.booking_channel AS channel,attribution.direct_booking_source AS "directSource",commission.snapshot_id AS "commissionSnapshotId",commission.commission_amount AS "commissionAmount",commission.evidence_state AS "commissionState",commission.created_at AS "commissionCreatedAt" FROM booking.finance_nightly_revenue_evidence revenue JOIN booking.finance_booking_attribution attribution ON attribution.guest_booking_id=revenue.guest_booking_id AND attribution.property_id=revenue.property_id LEFT JOIN finance.ota_commission_reporting_evidence commission ON commission.booking_revenue_evidence_id=revenue.evidence_id AND commission.property_id=revenue.property_id WHERE revenue.property_id=$1::uuid AND (revenue.recognized_on BETWEEN $3::date AND $4::date OR revenue.recognized_on BETWEEN $5::date AND $6::date)),lineage AS (SELECT evidence_id AS root_id,evidence_id,gross_room_amount FROM selected UNION ALL SELECT lineage.root_id,child.evidence_id,child.gross_room_amount FROM lineage JOIN selected child ON child.corrects_evidence_id=lineage.evidence_id),priced AS (SELECT root_id,bool_or(gross_room_amount IS NOT NULL) AS "hasRoomPrice" FROM lineage GROUP BY root_id) SELECT selected.*,priced."hasRoomPrice" FROM selected JOIN priced ON priced.root_id=selected.evidence_id`;

// Curated Finance-safe Booking views are the integration boundary; this adapter never reads guest PII.
// prettier-ignore
async function readFacts(client: Pick<Client, "query">, values: readonly unknown[]): Promise<FactRow[]> {
  return (await client.query<FactRow>(`WITH scoped AS (${SCOPED}),reporting AS (SELECT *,CASE WHEN recognized_on BETWEEN $3::date AND $4::date THEN 'current' ELSE 'comparison' END AS period FROM scoped WHERE currency=$2) SELECT period,recognized_on::text AS "recognizedOn",channel,"directSource",room_type_id::text AS "roomTypeId",COALESCE(sum(gross_room_amount),0)::text AS "grossRoomAmount",COALESCE(sum("commissionAmount") FILTER (WHERE "commissionState"='applied'),0)::text AS "otaCommissionAmount",COALESCE(sum(occupied_room_nights),0)::int AS "occupiedRoomNights",COALESCE(sum(occupied_room_nights) FILTER (WHERE "hasRoomPrice"),0)::int AS "pricedOccupiedRoomNights",(max(max(recognized_on)) OVER ())::text AS "bookingRevenueThrough",(max(max("commissionCreatedAt")) OVER ())::text AS "financeOtaCommissionAt" FROM reporting GROUP BY period,recognized_on,channel,"directSource",room_type_id ORDER BY period,recognized_on,channel,"directSource" NULLS FIRST,room_type_id`, values)).rows;
}

// prettier-ignore
async function readGaps(client: Pick<Client, "query">, values: readonly unknown[]): Promise<GapRow[]> {
  return (await client.query<GapRow>(`WITH scoped AS (${SCOPED}),gaps AS (SELECT 'room_revenue_currency_mismatch'::text AS code,count(*)::int AS count,CASE WHEN count(gross_room_amount)=count(*) THEN sum(gross_room_amount)::text END AS amount,currency::text AS currency FROM scoped WHERE currency<>$2 GROUP BY currency UNION ALL SELECT 'room_revenue_missing',count(*)::int,NULL,NULL FROM scoped WHERE gross_room_amount IS NULL AND NOT "hasRoomPrice" UNION ALL SELECT 'ota_commission_missing',count(*)::int,NULL,NULL FROM scoped WHERE currency=$2 AND channel IN ('booking_com','airbnb','expedia','agoda','other_ota') AND ("commissionSnapshotId" IS NULL OR "commissionState"<>'applied')) SELECT * FROM gaps WHERE count>0 ORDER BY code,currency NULLS FIRST`, values)).rows;
}

// Attach-rate eligibility is non-monetary and therefore independent of evidence currency.
// prettier-ignore
async function readEligibleBookings(client: Pick<Client, "query">, values: readonly unknown[]) {
  const rows = (await client.query<EligibleRow>(`WITH eligible AS (SELECT guest_booking_id,CASE WHEN recognized_on BETWEEN $3::date AND $4::date THEN 'current' ELSE 'comparison' END AS period FROM booking.finance_nightly_revenue_evidence WHERE property_id=$1::uuid AND length($2::text)=3 AND (recognized_on BETWEEN $3::date AND $4::date OR recognized_on BETWEEN $5::date AND $6::date) GROUP BY guest_booking_id,period HAVING sum(occupied_room_nights)>0) SELECT period,count(*)::int AS count FROM eligible GROUP BY period`, values)).rows;
  const counts = { current: 0, comparison: 0 };
  for (const row of rows) {
    if ((row.period !== "current" && row.period !== "comparison") || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error("Finance revenue eligible booking facts are invalid");
    counts[row.period] = row.count;
  }
  return counts;
}

function fact(row: FactRow): FinanceRevenueRoomFact {
  if (
    (row.period !== "current" && row.period !== "comparison") ||
    !localDate(row.recognizedOn) ||
    !row.channel.trim() ||
    (row.directSource !== null && !row.directSource.trim()) ||
    !UUID.test(row.roomTypeId) ||
    !Number.isSafeInteger(row.occupiedRoomNights) ||
    !Number.isSafeInteger(row.pricedOccupiedRoomNights)
  )
    throw new Error("Finance revenue room facts are invalid");
  return {
    period: row.period,
    recognizedOn: row.recognizedOn,
    channel: row.channel,
    directSource: row.directSource,
    roomTypeId: row.roomTypeId.toLowerCase(),
    grossRoomAmount: normalizeFinanceReportingDecimal(row.grossRoomAmount),
    otaCommissionAmount: normalizeFinanceReportingDecimal(row.otaCommissionAmount),
    occupiedRoomNights: row.occupiedRoomNights,
    pricedOccupiedRoomNights: row.pricedOccupiedRoomNights,
  };
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function gap(row: GapRow): FinanceRevenueRoomGap {
  if (!Number.isSafeInteger(row.count) || row.count < 1)
    throw new Error("Finance revenue incomplete evidence is invalid");
  if (row.code === "room_revenue_currency_mismatch") {
    if (row.currency === null || !/^[A-Z]{3}$/.test(row.currency))
      throw new Error("Finance revenue incomplete evidence currency is invalid");
    return row.amount === null
      ? { code: row.code, count: row.count, currency: row.currency }
      : {
          code: row.code,
          count: row.count,
          currency: row.currency,
          amount: { amount: normalizeFinanceReportingDecimal(row.amount), currency: row.currency },
        };
  }
  if (row.amount !== null || row.currency !== null)
    throw new Error("Finance revenue incomplete evidence shape is invalid");
  return { code: row.code, count: row.count };
}
function instant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Finance revenue freshness is invalid");
  return parsed.toISOString();
}
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance revenue property id is malformed");
  return value.toLowerCase();
}
// prettier-ignore
async function consistentRead<T>(pool: FinanceRevenueRoomFactsPool, read: (client: Client) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const value = await read(client); await client.query("COMMIT"); return value; } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); } }
