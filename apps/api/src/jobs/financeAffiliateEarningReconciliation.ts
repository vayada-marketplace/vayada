import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { parseStoredPricingQuote } from "@vayada/domain-booking";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { selectLastEligibleAffiliateClick } from "@vayada/domain-marketplace/internal/affiliate-attribution";
import { pricingDecimalMinor } from "../domains/pricingDecimalMinor.js";
import { resolvePgFinanceAffiliatePercentagePolicy } from "../domains/financeAffiliatePercentagePolicyResolver.js";
import {
  appendTrustedAffiliateEarningCalculation,
  type AffiliateEarningEvidenceResolver,
} from "../domains/financeAffiliateEarningJournal.js";

const HOLD_DAYS = 14;
type Candidate = { propertyId: string; bookingId: string; stayItemId: string };
type Beneficiary = { creatorProfileId: string; affiliateId: string; organizationId: string };
type Proof = {
  calculation: NonNullable<Awaited<ReturnType<AffiliateEarningEvidenceResolver>>>["calculation"];
  beneficiary: Beneficiary;
  actorUserId: string;
  hotelOrganizationId: string;
};
type RevenueRow = {
  currency: string;
  amount: string;
  economic_event: string;
  source_kind: string;
  evidence_quality: string;
  line_position: number;
  corrects_evidence_id?: string | null;
};
type PaymentRow = {
  currency: string;
  amount: string;
  refunded_amount: string;
  status: string;
  payment_kind: string;
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const signedMinor = (value: string, scale: number) => {
  const negative = value.startsWith("-");
  const minor = pricingDecimalMinor(negative ? value.slice(1) : value, scale);
  return minor === null ? null : `${negative && minor !== "0" ? "-" : ""}${minor}`;
};

export function resolveNetAccommodationMinor(
  quoteValue: unknown,
  bookingCurrency: string,
  rows: readonly RevenueRow[],
  assignment: { position: number; selectionId: string },
) {
  const quote = parseStoredPricingQuote(quoteValue);
  const scale = quote && pricingCurrencyScale(quote.stay.currency);
  if (
    !quote ||
    scale === null ||
    quote.stay.rooms.length !== 1 ||
    assignment.position !== 1 ||
    assignment.selectionId !== quote.stay.rooms[0]?.selectionId ||
    quote.stay.currency !== bookingCurrency ||
    quote.evidence.lines.some((line) => line.kind === "discount" && line.amountMinor !== "0") ||
    rows.some(
      (row) =>
        row.currency !== bookingCurrency ||
        row.evidence_quality !== "exact" ||
        (row.economic_event === "room_night"
          ? row.source_kind !== "direct"
          : !["direct", "manual"].includes(row.source_kind)) ||
        row.line_position !== 1 ||
        row.economic_event === "retained_charge" ||
        (row.economic_event !== "room_night" && !row.corrects_evidence_id),
    )
  )
    return null;
  const initial = rows.filter((row) => row.economic_event === "room_night");
  const gross = quote.rooms[0]!.nights.reduce((sum, night) => sum + BigInt(night.roomMinor), 0n);
  let initialMinor = 0n;
  let net = 0n;
  for (const row of rows) {
    const minor = signedMinor(row.amount, scale);
    if (minor === null) return null;
    net += BigInt(minor);
    if (row.economic_event === "room_night") initialMinor += BigInt(minor);
  }
  return initial.length === quote.rooms[0]!.nights.length && initialMinor === gross && net >= 0n
    ? { minor: net.toString(), scale, bookingTotalMinor: quote.evidence.totalMinor }
    : null;
}

export function hasExactBookingPaymentCoverage(
  bookingTotalMinor: string,
  bookingCurrency: string,
  scale: number,
  payments: readonly PaymentRow[],
) {
  if (!payments.length) return false;
  let settledMinor = 0n;
  let refundedMinor = 0n;
  let refundEvidenceMinor = 0n;
  for (const payment of payments) {
    const amount = signedMinor(payment.amount, scale);
    const refunded = signedMinor(payment.refunded_amount, scale);
    if (
      amount === null ||
      refunded === null ||
      payment.currency !== bookingCurrency ||
      !["deposit", "balance", "full", "manual", "refund"].includes(payment.payment_kind) ||
      !["paid", "partially_refunded", "refunded"].includes(payment.status)
    )
      return false;
    if (payment.payment_kind === "refund") {
      if (payment.status !== "refunded" || amount !== refunded) return false;
      refundEvidenceMinor += BigInt(amount);
    } else {
      settledMinor += BigInt(amount);
      refundedMinor += BigInt(refunded);
    }
  }
  return settledMinor.toString() === bookingTotalMinor && refundedMinor === refundEvidenceMinor;
}

/** Reconciles verified source evidence directly. It writes calculation history and the
 * settlement handoff, but deliberately does not allocate a payout or update a balance. */
export async function reconcileAffiliateEarning(
  pool: pg.Pool,
  input: Candidate,
): Promise<"eligible" | "unchanged" | "ineligible"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `affiliate-earning:${input.propertyId}:${input.bookingId}:${input.stayItemId}`,
    ]);
    const proof = await resolveTrustedProof(client, input);
    if (!proof) {
      await client.query("ROLLBACK");
      return "ineligible";
    }
    const evidenceDigest = digest({
      calculation: proof.calculation,
      beneficiary: proof.beneficiary,
      actorUserId: proof.actorUserId,
      hotelOrganizationId: proof.hotelOrganizationId,
    });
    const prior = await client.query<{ revision: number }>(
      `SELECT revision FROM finance.affiliate_earning_reconciliation_revisions
       WHERE property_id=$1::uuid AND booking_id=$2::uuid AND stay_item_id=$3::uuid
         AND evidence_digest=$4`,
      [input.propertyId, input.bookingId, input.stayItemId, evidenceDigest],
    );
    let sourceRevision = prior.rows[0]?.revision;
    if (!sourceRevision) {
      const latest = await client.query<{ revision: number }>(
        `SELECT revision FROM finance.affiliate_earning_reconciliation_revisions
         WHERE property_id=$1::uuid AND booking_id=$2::uuid AND stay_item_id=$3::uuid
         ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [input.propertyId, input.bookingId, input.stayItemId],
      );
      sourceRevision = (latest.rows[0]?.revision ?? 0) + 1;
      await client.query(
        `INSERT INTO finance.affiliate_earning_reconciliation_revisions
         (id,property_id,booking_id,stay_item_id,revision,evidence_digest,calculation_input,
          creator_profile_id,affiliate_id,beneficiary_organization_id,actor_user_id,hotel_organization_id)
         VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::uuid,$9,$10::uuid,$11::uuid,$12::uuid)`,
        [
          randomUUID(),
          input.propertyId,
          input.bookingId,
          input.stayItemId,
          sourceRevision,
          evidenceDigest,
          JSON.stringify(proof.calculation),
          proof.beneficiary.creatorProfileId,
          proof.beneficiary.affiliateId,
          proof.beneficiary.organizationId,
          proof.actorUserId,
          proof.hotelOrganizationId,
        ],
      );
    }
    const result = await appendTrustedAffiliateEarningCalculation(
      client,
      { ...input, sourceRevision },
      {
        actorUserId: proof.actorUserId,
        organizationId: proof.hotelOrganizationId,
        requestId: `affiliate-earning-reconciliation:${input.bookingId}:${sourceRevision}`,
      },
      persistedReconciliationResolver,
    );
    if (!result.ok || result.outcome.status !== "calculated") {
      await client.query("ROLLBACK");
      return "ineligible";
    }
    await client.query(
      `INSERT INTO finance.affiliate_eligible_earning_revisions
       (earning_entry_id,contract_version,property_id,booking_id,stay_item_id,agreement_id,
        policy_version_id,source_revision,creator_profile_id,affiliate_id,
        beneficiary_organization_id,currency,currency_minor_unit,commission_minor,
        adjustment_minor,status)
       VALUES($1,'finance-affiliate-settlement-entry.v1',$2::uuid,$3::uuid,$4::uuid,$5::uuid,
        $6::uuid,$7,$8::uuid,$9,$10::uuid,$11,$12,$13::numeric,$14::numeric,'eligible')
       ON CONFLICT(earning_entry_id) DO NOTHING`,
      [
        result.entryId,
        input.propertyId,
        input.bookingId,
        input.stayItemId,
        result.outcome.snapshot.scope.agreementId,
        result.outcome.snapshot.scope.policyVersionId,
        sourceRevision,
        proof.beneficiary.creatorProfileId,
        proof.beneficiary.affiliateId,
        proof.beneficiary.organizationId,
        result.outcome.snapshot.scope.currency,
        result.outcome.snapshot.scope.currencyMinorUnit,
        result.outcome.snapshot.commissionMinor,
        result.outcome.adjustmentMinor,
      ],
    );
    await client.query("COMMIT");
    return result.replayed ? "unchanged" : "eligible";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runAffiliateEarningReconciliationCycle(
  pool: pg.Pool,
  options: { limit?: number } = {},
) {
  const candidates = await pool.query<Candidate>(
    `SELECT assignment.property_id::text AS "propertyId",
      assignment.guest_booking_id::text AS "bookingId",assignment.id::text AS "stayItemId"
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking ON booking.id=assignment.guest_booking_id
       AND booking.property_id=assignment.property_id
     JOIN pms.booking_checkout_records checkout ON checkout.property_id=assignment.property_id
       AND checkout.guest_booking_id=assignment.guest_booking_id
       AND (checkout.assignment_id=assignment.id OR (checkout.assignment_id IS NULL AND NOT EXISTS(
         SELECT 1 FROM pms.operational_booking_assignments sibling
         WHERE sibling.guest_booking_id=assignment.guest_booking_id AND sibling.id<>assignment.id)))
     JOIN booking.affiliate_original_booking_bindings binding
       ON binding.booking_id=assignment.guest_booking_id AND binding.property_id=assignment.property_id
       AND binding.synthetic=FALSE
     LEFT JOIN LATERAL (
       SELECT recorded_at FROM finance.affiliate_earning_reconciliation_revisions revision
       WHERE revision.property_id=assignment.property_id
         AND revision.booking_id=assignment.guest_booking_id AND revision.stay_item_id=assignment.id
       ORDER BY revision.revision DESC LIMIT 1
     ) prior ON TRUE
     LEFT JOIN LATERAL (
       SELECT max(created_at) changed_at FROM booking.nightly_revenue_evidence evidence
       WHERE evidence.property_id=assignment.property_id
         AND evidence.guest_booking_id=assignment.guest_booking_id
     ) revenue ON TRUE
     WHERE assignment.assignment_status IN ('checked_out','canceled')
       AND checkout.pending_flags='[]'::jsonb
       AND checkout.completed_at <= clock_timestamp()-make_interval(days=>$1)
       AND (prior.recorded_at IS NULL OR GREATEST(revenue.changed_at,booking.updated_at)>prior.recorded_at)
     ORDER BY checkout.completed_at,assignment.id LIMIT $2`,
    [HOLD_DAYS, options.limit ?? 25],
  );
  const outcomes = { eligible: 0, unchanged: 0, ineligible: 0 };
  for (const candidate of candidates.rows)
    outcomes[await reconcileAffiliateEarning(pool, candidate)]++;
  return outcomes;
}

const persistedReconciliationResolver: AffiliateEarningEvidenceResolver = async (client, input) => {
  const row = (
    await client.query<{ calculation: Proof["calculation"] }>(
      `SELECT calculation_input AS calculation
       FROM finance.affiliate_earning_reconciliation_revisions
       WHERE property_id=$1::uuid AND booking_id=$2::uuid AND stay_item_id=$3::uuid AND revision=$4`,
      [input.propertyId, input.bookingId, input.stayItemId, input.sourceRevision],
    )
  ).rows[0];
  return row ? { sourceRevision: input.sourceRevision, calculation: row.calculation } : null;
};

async function resolveTrustedProof(client: pg.PoolClient, input: Candidate): Promise<Proof | null> {
  const binding = (
    await client.query(
      `SELECT booking.created_at AS booked_at,booking.lifecycle_status,booking.payment_status,
        booking.currency,booking.check_in::text,booking.check_out::text,booking.room_count,
        binding.context_id,binding.history_cutoff::text,binding.original_check_in::text,
        binding.original_check_out::text,binding.original_currency
       FROM booking.guest_bookings booking JOIN booking.affiliate_original_booking_bindings binding
        ON binding.booking_id=booking.id AND binding.property_id=booking.property_id
       WHERE booking.id=$1::uuid AND booking.property_id=$2::uuid AND binding.synthetic=FALSE
       FOR SHARE OF booking,binding`,
      [input.bookingId, input.propertyId],
    )
  ).rows[0];
  if (
    !binding ||
    !["confirmed", "completed", "canceled", "no_show"].includes(binding.lifecycle_status) ||
    !["paid", "refunded"].includes(binding.payment_status) ||
    binding.room_count !== 1 ||
    binding.check_in !== binding.original_check_in ||
    binding.check_out !== binding.original_check_out ||
    binding.currency !== binding.original_currency
  )
    return null;
  const clicks = (
    await client.query(
      `SELECT occurrence.id::text AS "clickId",link.id::text AS "linkId",
        agreement.creator_profile_id::text AS "creatorProfileId",agreement.id::text AS "agreementId",
        terms.id::text AS "termsVersionId",admission.history_position::text AS "historyPosition",
        occurrence.clicked_at AS "clickedAt",(terms.disclosure::jsonb#>>'{terms,attributionWindowDays}')::int AS "attributionWindowDays",
        occurrence.synthetic AS "isTest",'eligible'::text AS eligibility
       FROM booking.affiliate_click_admissions admission
       JOIN marketplace.affiliate_click_occurrences occurrence ON occurrence.id=admission.click_id
       JOIN marketplace.affiliate_links link ON link.id=occurrence.link_id AND link.property_id=occurrence.property_id
       JOIN marketplace.affiliate_agreements agreement ON agreement.id=link.agreement_id
       JOIN marketplace.affiliate_agreement_activations activation
         ON activation.id=link.activation_id AND activation.agreement_id=agreement.id
       JOIN marketplace.affiliate_published_terms terms
         ON terms.id=occurrence.terms_id AND terms.id=activation.terms_id
       WHERE admission.context_id=$1::uuid AND admission.history_position<=$2::bigint
       ORDER BY admission.history_position FOR SHARE`,
      [binding.context_id, binding.history_cutoff],
    )
  ).rows.map((row) => ({
    ...row,
    bookingId: input.bookingId,
    propertyId: input.propertyId,
    clickedAt: new Date(row.clickedAt).toISOString(),
  }));
  const attribution = selectLastEligibleAffiliateClick({
    bookingId: input.bookingId,
    propertyId: input.propertyId,
    bookedAt: new Date(binding.booked_at).toISOString(),
    clickHistoryCutoff: binding.history_cutoff,
    evidenceComplete: true,
    candidates: clicks,
  });
  if (attribution.status !== "attributed") return null;
  const owner = (
    await client.query(
      `SELECT agreement.hotel_organization_id::text AS "hotelOrganizationId",
        agreement.creator_organization_id::text AS "organizationId",
        terms.disclosure::jsonb#>>'{terms,financePolicyVersionId}' AS "policyVersionId",
        affiliate.resource_id AS "affiliateId"
       FROM marketplace.affiliate_agreements agreement
       JOIN marketplace.affiliate_agreement_activations activation ON activation.agreement_id=agreement.id
       JOIN marketplace.affiliate_published_terms terms ON terms.id=activation.terms_id
       JOIN marketplace.creator_profiles profile ON profile.id=agreement.creator_profile_id
         AND profile.organization_id=agreement.creator_organization_id
       JOIN identity.organization_resource_links creator_link
         ON creator_link.organization_id=agreement.creator_organization_id
         AND creator_link.product='marketplace' AND creator_link.resource_type='creator_profile'
         AND creator_link.resource_id=agreement.creator_profile_id::text AND creator_link.status='active'
         AND creator_link.relationship='owner'
       JOIN identity.organization_resource_links affiliate
         ON affiliate.organization_id=agreement.creator_organization_id
         AND affiliate.product='affiliate' AND affiliate.resource_type='affiliate'
         AND affiliate.status='active' AND affiliate.relationship='owner'
       WHERE agreement.id=$1::uuid AND agreement.property_id=$2::uuid
       ORDER BY creator_link.id,affiliate.id
       FOR SHARE OF agreement,activation,terms,profile,creator_link,affiliate`,
      [attribution.agreementId, input.propertyId],
    )
  ).rows;
  if (owner.length !== 1 || !owner[0]?.affiliateId || !owner[0].policyVersionId) return null;
  const beneficiary = owner[0];
  const completion = (
    await client.query(
      `SELECT checkout.id::text,checkout.completed_by_user_id::text AS "actorUserId",
        checkout.completed_at,checkout.pending_flags,audit.id::text AS "auditId"
       FROM pms.operational_booking_assignments assignment
       JOIN pms.booking_checkout_records checkout ON checkout.property_id=assignment.property_id
        AND checkout.guest_booking_id=assignment.guest_booking_id
        AND (checkout.assignment_id=assignment.id OR (checkout.assignment_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM pms.operational_booking_assignments sibling
          WHERE sibling.guest_booking_id=assignment.guest_booking_id AND sibling.id<>assignment.id)))
       JOIN platform.product_audit_events audit ON audit.product='pms'
        AND audit.action='pms.checkout.completed' AND audit.action_version=1
        AND audit.tenant_scope='property' AND audit.property_id=assignment.property_id
        AND audit.target_resource_product='pms'
        AND audit.target_resource_type='booking_checkout_record'
        AND audit.target_resource_id=checkout.id::text
        AND audit.secondary_resource_product='booking'
        AND audit.secondary_resource_type='guest_booking'
        AND audit.secondary_resource_id=assignment.guest_booking_id::text
        AND audit.actor_type='user' AND length(btrim(audit.causation_id))>0
        AND audit.actor_user_id=checkout.completed_by_user_id AND audit.occurred_at=checkout.completed_at
       WHERE assignment.id=$1::uuid AND assignment.property_id=$2::uuid
        AND assignment.guest_booking_id=$3::uuid
        AND assignment.assignment_status IN ('checked_out','canceled')
        AND checkout.completed_at<=clock_timestamp()-make_interval(days=>$4)
       ORDER BY checkout.completed_at DESC LIMIT 1 FOR SHARE OF assignment,checkout,audit`,
      [input.stayItemId, input.propertyId, input.bookingId, HOLD_DAYS],
    )
  ).rows[0];
  if (!completion || completion.pending_flags?.length !== 0) return null;
  const accepted = (
    await client.query(
      `SELECT acceptance.id::text,acceptance.quote_snapshot,assignment.position,
        assignment.assignment_payload,evidence.id::text AS "evidenceId",evidence.stay_date::text AS "stayDate",
        evidence.currency,evidence.gross_room_amount::text AS amount,evidence.economic_event,
        evidence.source_kind,evidence.evidence_quality,evidence.line_position,
        evidence.corrects_evidence_id::text
       FROM booking.pricing_quote_acceptances acceptance
       JOIN pms.operational_booking_assignments assignment
        ON assignment.guest_booking_id=acceptance.guest_booking_id AND assignment.property_id=acceptance.property_id
       JOIN booking.nightly_revenue_evidence evidence
        ON evidence.guest_booking_id=acceptance.guest_booking_id AND evidence.property_id=acceptance.property_id
       WHERE acceptance.guest_booking_id=$1::uuid AND acceptance.property_id=$2::uuid
        AND assignment.id=$3::uuid ORDER BY evidence.source_revision,evidence.created_at,evidence.id FOR SHARE`,
      [input.bookingId, input.propertyId, input.stayItemId],
    )
  ).rows;
  const payload = accepted[0]?.assignment_payload?.pricingAcceptance;
  if (!payload?.acceptanceId || payload.acceptanceId !== accepted[0]?.id || !payload.selectionId)
    return null;
  const accommodation = resolveNetAccommodationMinor(
    accepted[0]?.quote_snapshot,
    binding.currency,
    accepted,
    { position: accepted[0].position, selectionId: payload.selectionId },
  );
  if (!accommodation) return null;
  const payments = (
    await client.query(
      `SELECT id::text,currency,amount::text,refunded_amount::text,status,payment_kind
       FROM finance.payments WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid
        AND status IN ('paid','partially_refunded','refunded')
       ORDER BY created_at,id FOR SHARE`,
      [input.propertyId, input.bookingId],
    )
  ).rows;
  if (
    !hasExactBookingPaymentCoverage(
      accommodation.bookingTotalMinor,
      binding.currency,
      accommodation.scale,
      payments,
    )
  )
    return null;
  if (payments.length + accepted.length > 95) return null;
  const stay: "completed" | "cancelled" | "no_show" =
    binding.lifecycle_status === "canceled"
      ? "cancelled"
      : binding.lifecycle_status === "no_show"
        ? "no_show"
        : "completed";
  if (stay !== "completed" && accommodation.minor !== "0") return null;
  if (
    stay !== "completed" &&
    !(
      await client.query(
        `SELECT 1 FROM finance.affiliate_earning_journal
       WHERE property_id=$1::uuid AND booking_id=$2 AND stay_item_id=$3
         AND outcome->>'status'='calculated' LIMIT 1`,
        [input.propertyId, input.bookingId, input.stayItemId],
      )
    ).rowCount
  )
    return null;
  const policy = await resolvePgFinanceAffiliatePercentagePolicy(client, {
    propertyId: input.propertyId,
    policyVersionId: beneficiary.policyVersionId,
  });
  if (policy.status !== "available") return null;
  return {
    beneficiary: {
      creatorProfileId: attribution.creatorProfileId,
      affiliateId: beneficiary.affiliateId,
      organizationId: beneficiary.organizationId,
    },
    actorUserId: completion.actorUserId,
    hotelOrganizationId: beneficiary.hotelOrganizationId,
    calculation: {
      scope: {
        propertyId: input.propertyId,
        creatorProfileId: attribution.creatorProfileId,
        agreementId: attribution.agreementId,
        policyVersionId: beneficiary.policyVersionId,
        bookingId: input.bookingId,
        stayItemId: input.stayItemId,
        currency: binding.currency,
        currencyMinorUnit: accommodation.scale,
        rounding: "half_up",
      },
      policy: {
        policyVersionId: beneficiary.policyVersionId,
        propertyId: input.propertyId,
        approvalStatus: "approved",
        policy: policy.policy,
      },
      evidence: {
        status: "verified",
        stay,
        netAccommodationMinor: stay === "completed" ? accommodation.minor : "0",
        references: [
          attribution.clickId,
          attribution.termsVersionId,
          completion.id,
          completion.auditId,
          ...payments.map((payment) => payment.id),
          ...accepted.map((row) => row.evidenceId),
        ],
      },
    },
  };
}
