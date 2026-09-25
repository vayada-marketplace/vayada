import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type AffiliateSettlementEntryV1 = {
  contractVersion: "finance-affiliate-settlement-entry.v1";
  earningEntryId: string;
  recordedAt: string;
  beneficiary: { creatorProfileId: string; affiliateId: string; organizationId: string };
  source: {
    propertyId: string;
    bookingId: string;
    stayItemId: string;
    agreementId: string;
    policyVersionId: string;
    sourceRevision: number;
  };
  money: {
    currency: string;
    currencyMinorUnit: number;
    commissionMinor: string;
    adjustmentMinor: string;
  };
  status: "eligible";
};

export type AffiliateSettlementResult =
  | { ok: true; status: "allocated" | "blocked" | "correction_review" | "idempotent_replay" }
  | { ok: false; code: "invalid_entry" | "earning_entry_conflict" };

type AllocationRow = { entryDigest: string; status: string };
type SettingsRow = {
  payoutSettingId: string;
  payoutMethod: "stripe" | "manual" | "bank_transfer" | "bank" | "bank_account";
  payoutCurrency: string;
  scheduleType: "manual" | "monthly" | "threshold";
  thresholdAmount: string | null;
  providerAccountId: string | null;
  providerStatus: string | null;
  providerPayoutsEnabled: boolean | null;
  destinationReady: boolean;
};
type PayoutRow = { payoutId: string; amount: string };
const MAX_FINANCE_PAYOUT_MINOR = 999_999_999_999_999n;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const unsigned = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,29})$/.test(value);
const signed = (value: unknown): value is string =>
  typeof value === "string" && /^-?(0|[1-9][0-9]{0,29})$/.test(value) && value !== "-0";

export function normalizeAffiliateSettlementEntry(
  value: unknown,
): AffiliateSettlementEntryV1 | null {
  const entry = value as AffiliateSettlementEntryV1;
  if (
    !entry ||
    entry.contractVersion !== "finance-affiliate-settlement-entry.v1" ||
    entry.status !== "eligible" ||
    !uuid(entry.earningEntryId) ||
    !entry.beneficiary ||
    !entry.source ||
    !entry.money ||
    !reference(entry.beneficiary.creatorProfileId) ||
    !reference(entry.beneficiary.affiliateId) ||
    !uuid(entry.beneficiary.organizationId) ||
    !uuid(entry.source.propertyId) ||
    ![
      entry.source.bookingId,
      entry.source.stayItemId,
      entry.source.agreementId,
      entry.source.policyVersionId,
    ].every(reference) ||
    !Number.isSafeInteger(entry.source.sourceRevision) ||
    entry.source.sourceRevision < 1 ||
    !/^[A-Z]{3}$/.test(entry.money.currency) ||
    !Number.isInteger(entry.money.currencyMinorUnit) ||
    entry.money.currencyMinorUnit < 0 ||
    entry.money.currencyMinorUnit > 9 ||
    !unsigned(entry.money.commissionMinor) ||
    !signed(entry.money.adjustmentMinor) ||
    !Number.isFinite(Date.parse(entry.recordedAt))
  )
    return null;
  return JSON.parse(JSON.stringify(entry)) as AffiliateSettlementEntryV1;
}

export async function allocateAffiliateSettlementEntry(
  pool: Pick<Pool, "connect">,
  value: unknown,
  now = new Date(),
): Promise<AffiliateSettlementResult> {
  const entry = normalizeAffiliateSettlementEntry(value);
  if (!entry) return { ok: false, code: "invalid_entry" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const digest = sha256(stableJson(entry));
    const reservation = await reserve(client, entry, digest, now);
    if (reservation) {
      await client.query("ROLLBACK");
      return reservation.entryDigest === digest
        ? { ok: true, status: "idempotent_replay" }
        : { ok: false, code: "earning_entry_conflict" };
    }

    const settings = await loadSettings(client, entry);
    const blocker = readinessBlocker(entry, settings);
    const adjustment = BigInt(entry.money.adjustmentMinor);
    if (adjustment < 0n && entry.money.currencyMinorUnit === 2) {
      const remainder = await applyCorrection(client, entry, -adjustment, now);
      const status = remainder === 0n ? "allocated" : "correction_review";
      await finish(client, entry.earningEntryId, status, null, -remainder, now);
      await client.query("COMMIT");
      return { ok: true, status };
    }
    if (blocker || adjustment === 0n) {
      const status = blocker ? "blocked" : "allocated";
      await finish(client, entry.earningEntryId, status, blocker, 0n, now);
      await client.query("COMMIT");
      return { ok: true, status };
    }

    const payoutId = await createPayout(client, entry, settings!, adjustment, now);
    await client.query(
      `INSERT INTO finance.affiliate_earning_allocation_items
       (earning_entry_id,payout_id,applied_minor) VALUES ($1,$2,$3)`,
      [entry.earningEntryId, payoutId, adjustment.toString()],
    );
    await finish(client, entry.earningEntryId, "allocated", null, 0n, now);
    await client.query("COMMIT");
    return { ok: true, status: "allocated" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function reserve(
  client: PoolClient,
  entry: AffiliateSettlementEntryV1,
  digest: string,
  now: Date,
): Promise<AllocationRow | null> {
  const inserted = await client.query(
    `INSERT INTO finance.affiliate_earning_allocations (
       earning_entry_id,entry_digest,entry_snapshot,creator_profile_id,affiliate_id,
       organization_id,property_id,booking_id,stay_item_id,agreement_id,policy_version_id,
       source_revision,currency,currency_minor_unit,commission_minor,adjustment_minor,
       status,recorded_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'processing',$17,$18)
     ON CONFLICT DO NOTHING RETURNING earning_entry_id`,
    [
      entry.earningEntryId,
      digest,
      JSON.stringify(entry),
      entry.beneficiary.creatorProfileId,
      entry.beneficiary.affiliateId,
      entry.beneficiary.organizationId,
      entry.source.propertyId,
      entry.source.bookingId,
      entry.source.stayItemId,
      entry.source.agreementId,
      entry.source.policyVersionId,
      entry.source.sourceRevision,
      entry.money.currency,
      entry.money.currencyMinorUnit,
      entry.money.commissionMinor,
      entry.money.adjustmentMinor,
      entry.recordedAt,
      now.toISOString(),
    ],
  );
  if (inserted.rowCount) return null;
  const existing = await client.query<AllocationRow>(
    `SELECT entry_digest AS "entryDigest",status
     FROM finance.affiliate_earning_allocations WHERE earning_entry_id=$1 FOR UPDATE`,
    [entry.earningEntryId],
  );
  const row = existing.rows[0] ?? null;
  if (row?.entryDigest === digest && row.status === "blocked") {
    await client.query(
      `UPDATE finance.affiliate_earning_allocations
       SET status='processing',blocker=NULL,updated_at=$2 WHERE earning_entry_id=$1`,
      [entry.earningEntryId, now.toISOString()],
    );
    return null;
  }
  return row;
}

async function loadSettings(
  client: PoolClient,
  entry: AffiliateSettlementEntryV1,
): Promise<SettingsRow | null> {
  const result = await client.query<SettingsRow>(
    `SELECT settings.id::text AS "payoutSettingId", settings.payout_method AS "payoutMethod",
       settings.default_currency AS "payoutCurrency", settings.schedule->>'type' AS "scheduleType",
       settings.schedule->>'thresholdAmount' AS "thresholdAmount",
       settings.sensitive_destination_ref IS NOT NULL AS "destinationReady",
       account.id::text AS "providerAccountId", account.status AS "providerStatus",
       account.payouts_enabled AS "providerPayoutsEnabled"
     FROM identity.organization_resource_links link
     JOIN identity.organizations organization ON organization.id=link.organization_id
       AND organization.kind='affiliate_partner' AND organization.status='active'
     JOIN finance.payout_settings settings ON settings.organization_id=link.organization_id
       AND settings.owner_scope='organization' AND settings.status='active'
       AND settings.payout_preferences->>'affiliateId'=link.resource_id
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id=settings.organization_provider_account_id
       AND account.organization_id=settings.organization_id AND account.account_scope='organization'
     WHERE link.organization_id=$1 AND link.product='affiliate' AND link.resource_type='affiliate'
       AND link.resource_id=$2 AND link.status='active' LIMIT 2 FOR UPDATE OF settings`,
    [entry.beneficiary.organizationId, entry.beneficiary.affiliateId],
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}

function readinessBlocker(
  entry: AffiliateSettlementEntryV1,
  settings: SettingsRow | null,
): string | null {
  if (entry.money.currencyMinorUnit !== 2) return "unsupported_currency_precision";
  if (BigInt(entry.money.adjustmentMinor) > MAX_FINANCE_PAYOUT_MINOR)
    return "payout_amount_exceeds_finance_capacity";
  if (!settings) return "payout_readiness_missing";
  if (settings.payoutCurrency !== entry.money.currency) return "currency_mismatch";
  if (!["manual", "monthly", "threshold"].includes(settings.scheduleType))
    return "unsupported_payout_schedule";
  if (
    !["stripe", "manual", "bank_transfer", "bank", "bank_account"].includes(settings.payoutMethod)
  )
    return "unsupported_payout_method";
  if (
    settings.payoutMethod === "stripe" &&
    (!settings.providerAccountId ||
      settings.providerStatus !== "active" ||
      !settings.providerPayoutsEnabled)
  )
    return "provider_not_ready";
  if (
    ["bank_transfer", "bank", "bank_account"].includes(settings.payoutMethod) &&
    !settings.destinationReady
  )
    return "destination_not_ready";
  if (settings.scheduleType === "threshold") {
    const threshold = settings.thresholdAmount ? decimalToMinor(settings.thresholdAmount) : null;
    if (threshold === null || threshold <= 0n) return "threshold_not_configured";
  }
  return null;
}

async function createPayout(
  client: PoolClient,
  entry: AffiliateSettlementEntryV1,
  settings: SettingsRow,
  adjustment: bigint,
  now: Date,
): Promise<string> {
  const scheduledAt = settings.scheduleType === "monthly" ? nextMonthlyRun(now) : null;
  const threshold = settings.thresholdAmount ? decimalToMinor(settings.thresholdAmount) : null;
  const pending =
    settings.scheduleType === "threshold"
      ? await client.query<{ amount: string }>(
          `SELECT amount::text FROM finance.payouts WHERE owner_scope='organization'
           AND organization_id=$1 AND currency=$2 AND payout_status='pending'
           AND payout_metadata->>'affiliateId'=$3
           AND payout_setting_id=$4
           AND payout_metadata->>'thresholdPending'='true' FOR UPDATE`,
          [
            entry.beneficiary.organizationId,
            entry.money.currency,
            entry.beneficiary.affiliateId,
            settings.payoutSettingId,
          ],
        )
      : { rows: [] };
  const pendingMinor = pending.rows.reduce((sum, row) => {
    const amount = decimalToMinor(row.amount);
    if (amount === null) throw new Error("Affiliate payout amount is not two-decimal money.");
    return sum + amount;
  }, 0n);
  const thresholdReady =
    settings.scheduleType !== "threshold" ||
    (threshold !== null && pendingMinor + adjustment >= threshold);
  const ready = thresholdReady;
  const result = await client.query<{ payoutId: string }>(
    `INSERT INTO finance.payouts (
       payout_setting_id,organization_provider_account_id,owner_scope,organization_id,
       related_property_id,source_system,source_payout_id,payout_status,amount,net_amount,
       currency,scheduled_at,payout_metadata
     ) VALUES ($1,$2,'organization',$3,$4,'finance',$5,$6,$7,$7,$8,$9,$10)
     RETURNING id::text AS "payoutId"`,
    [
      settings.payoutSettingId,
      settings.providerAccountId,
      entry.beneficiary.organizationId,
      entry.source.propertyId,
      `affiliate-earning:${entry.earningEntryId}`,
      ready && settings.scheduleType !== "manual" ? "scheduled" : "pending",
      minorToDecimal(adjustment),
      entry.money.currency,
      (settings.scheduleType === "threshold" && thresholdReady
        ? now
        : scheduledAt
      )?.toISOString() ?? null,
      JSON.stringify({
        affiliateId: entry.beneficiary.affiliateId,
        creatorProfileId: entry.beneficiary.creatorProfileId,
        affiliateSettlementReady: ready,
        thresholdPending: !thresholdReady,
        earningEntryId: entry.earningEntryId,
        commissionMinor: entry.money.commissionMinor,
      }),
    ],
  );
  const payoutId = result.rows[0]!.payoutId;
  let activatedPayoutIds: string[] = [];
  if (settings.scheduleType === "threshold" && thresholdReady) {
    const activated = await client.query<{ payoutId: string }>(
      `UPDATE finance.payouts SET payout_status='scheduled',scheduled_at=$1,
         organization_provider_account_id=$5,
         payout_metadata=(payout_metadata-'thresholdPending') || '{"affiliateSettlementReady":true}'::jsonb,
         updated_at=$1 WHERE owner_scope='organization' AND organization_id=$2 AND currency=$3
         AND payout_status='pending' AND payout_metadata->>'affiliateId'=$4
         AND payout_setting_id=$6 AND payout_metadata->>'thresholdPending'='true'
         RETURNING id::text AS "payoutId"`,
      [
        now.toISOString(),
        entry.beneficiary.organizationId,
        entry.money.currency,
        entry.beneficiary.affiliateId,
        settings.providerAccountId,
        settings.payoutSettingId,
      ],
    );
    activatedPayoutIds = activated.rows.map((row) => row.payoutId);
  }
  if (ready && settings.payoutMethod === "stripe" && settings.scheduleType !== "manual") {
    for (const readyPayoutId of [payoutId, ...activatedPayoutIds])
      await enqueuePayout(client, entry, readyPayoutId, scheduledAt ?? now);
  }
  return payoutId;
}

async function enqueuePayout(
  client: PoolClient,
  entry: AffiliateSettlementEntryV1,
  payoutId: string,
  runAfter: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.jobs (job_key,queue_name,job_type,status,run_after,tenant_scope,
       organization_id,resource_product,resource_type,resource_id,payload)
     VALUES ($1,'finance-affiliate-payout-dispatch','finance.dispatch-affiliate-payout','pending',
       $2,'organization',$3,'finance','payout',$4,$5) ON CONFLICT (queue_name,job_key) DO NOTHING`,
    [
      `finance.dispatch-affiliate-payout:affiliate:${entry.beneficiary.affiliateId}:payout:${payoutId}:v1`,
      runAfter.toISOString(),
      entry.beneficiary.organizationId,
      payoutId,
      JSON.stringify({ payoutId, affiliateId: entry.beneficiary.affiliateId }),
    ],
  );
}

async function applyCorrection(
  client: PoolClient,
  entry: AffiliateSettlementEntryV1,
  requested: bigint,
  now: Date,
): Promise<bigint> {
  const result = await client.query<PayoutRow>(
    `SELECT id::text AS "payoutId",amount::text FROM finance.payouts
     WHERE owner_scope='organization' AND organization_id=$1 AND related_property_id=$2
       AND currency=$3 AND payout_status IN ('pending','scheduled','failed')
       AND provider_payout_id IS NULL AND payout_metadata->>'affiliateId'=$4
       AND payout_metadata->>'creatorProfileId'=$5
       AND NOT EXISTS (SELECT 1 FROM platform.jobs job WHERE job.resource_product='finance'
         AND job.resource_type='payout' AND job.resource_id=finance.payouts.id::text
         AND NOT (job.queue_name='finance-affiliate-payout-dispatch'
           AND job.status='pending' AND job.attempts_count=0))
       AND NOT EXISTS (SELECT 1 FROM finance.affiliate_payout_payment_evidence_items evidence
         WHERE evidence.payout_id=finance.payouts.id)
     ORDER BY created_at,id FOR UPDATE`,
    [
      entry.beneficiary.organizationId,
      entry.source.propertyId,
      entry.money.currency,
      entry.beneficiary.affiliateId,
      entry.beneficiary.creatorProfileId,
    ],
  );
  let remainder = requested;
  for (const payout of result.rows) {
    if (remainder === 0n) break;
    const available = decimalToMinor(payout.amount);
    if (available === null) throw new Error("Affiliate payout amount is not two-decimal money.");
    const applied = available < remainder ? available : remainder;
    await client.query(
      `UPDATE finance.payouts SET amount=$1,net_amount=$1,
         payout_status=CASE WHEN $1::numeric=0 THEN 'canceled' ELSE payout_status END,
         updated_at=$2 WHERE id=$3`,
      [minorToDecimal(available - applied), now.toISOString(), payout.payoutId],
    );
    if (available === applied)
      await client.query(
        `UPDATE platform.jobs SET status='canceled',finished_at=$1,updated_at=$1
         WHERE queue_name='finance-affiliate-payout-dispatch' AND resource_product='finance'
           AND resource_type='payout' AND resource_id=$2 AND status='pending' AND attempts_count=0`,
        [now.toISOString(), payout.payoutId],
      );
    await client.query(
      `INSERT INTO finance.affiliate_earning_allocation_items
       (earning_entry_id,payout_id,applied_minor) VALUES ($1,$2,$3)`,
      [entry.earningEntryId, payout.payoutId, (-applied).toString()],
    );
    remainder -= applied;
  }
  return remainder;
}

async function finish(
  client: PoolClient,
  earningEntryId: string,
  status: "blocked" | "allocated" | "correction_review",
  blocker: string | null,
  unapplied: bigint,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE finance.affiliate_earning_allocations SET status=$2,blocker=$3,unapplied_minor=$4,
       allocated_at=CASE WHEN $2='blocked' THEN NULL ELSE $5::timestamptz END,
       updated_at=$5::timestamptz
     WHERE earning_entry_id=$1`,
    [earningEntryId, status, blocker, unapplied.toString(), now.toISOString()],
  );
}

function nextMonthlyRun(now: Date): Date {
  const run = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
  if (run <= now) run.setUTCMonth(run.getUTCMonth() + 1);
  return run;
}

function decimalToMinor(value: string): bigint | null {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value);
  return match ? BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0")) : null;
}
function minorToDecimal(value: bigint): string {
  const digits = value.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
