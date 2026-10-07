import { createHash } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import {
  requireActiveEntitlement,
  requirePermission,
  requirePropertyAccess,
  requireResourceAccess,
} from "@vayada/backend-authorization";
import pg from "pg";

import {
  readAffiliateAttributedBookings,
  type AffiliateAttributedBooking,
} from "./bookingAffiliatePerformanceRead.js";
import {
  readLatestAffiliateEarningOutcomes,
  type FinanceAffiliateEarningOutcome,
} from "./financeAffiliateEarningOutcomeRead.js";

export type AffiliatePerformanceQuery = {
  from: string;
  to: string;
  propertyId?: string;
  source?: "instagram" | "tiktok" | "youtube" | "facebook" | "x" | "unknown";
  campaign?: string;
  cursor?: string;
  limit: number;
};

export type AffiliatePerformancePartnership = {
  agreementId: string;
  propertyId: string;
  propertyName: string;
  creatorProfileId: string;
  clicks: number;
  bookings: number;
  stays: { total: number; calculated: number; pending: number; needsReview: number };
  commissions: Array<{
    currency: string;
    currencyMinorUnit: number;
    calculatedMinor: string;
    adjustmentMinor: string;
  }>;
  sources: Array<{ source: string; clicks: number }>;
  campaigns: Array<{ campaign: string | null; clicks: number }>;
  freshness: "current" | "stale" | "unknown";
};

export type AffiliatePerformancePage = {
  coverage: "available";
  readAt: string;
  period: {
    from: string;
    to: string;
    clickCohort: "clicked_at";
    bookingCohort: "booked_at";
    earningCohort: "latest_outcome_recorded_at";
  };
  filters: { propertyId: string | null; source: string | null; campaign: string | null };
  partnerships: AffiliatePerformancePartnership[];
  nextCursor: string | null;
};

type Queryable = Pick<pg.Pool, "query">;
type AgreementRow = {
  agreementId: string;
  propertyId: string;
  propertyName: string;
  creatorProfileId: string;
};
type ClickRow = { agreementId: string; source: string; campaign: string | null; count: number };
export type AffiliatePerformanceReadModel = {
  read(
    context: RequestContext,
    query: AffiliatePerformanceQuery,
  ): Promise<AffiliatePerformancePage>;
  close?: () => Promise<void>;
};

export function affiliatePerformanceCursorPeriod(cursor: string) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 5 &&
      value.slice(0, 5).every((item) => typeof item === "string") &&
      new Date(value[1]).toISOString() === value[1] &&
      new Date(value[2]).toISOString() === value[2]
    )
      return { from: value[1] as string, to: value[2] as string };
  } catch {}
  throw new Error("invalid affiliate performance cursor");
}

export function createPgAffiliatePerformanceReadModel(
  connectionString: string,
): AffiliatePerformanceReadModel {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    read: (context: RequestContext, query: AffiliatePerformanceQuery) =>
      readAffiliatePerformance(pool, context, query),
    close: () => pool.end(),
  };
}

export async function readAffiliatePerformance(
  database: Queryable,
  context: RequestContext,
  query: AffiliatePerformanceQuery,
): Promise<AffiliatePerformancePage> {
  const scope = await authorize(context, query.propertyId);
  const binding = createHash("sha256")
    .update(
      JSON.stringify([scope, query.from, query.to, query.propertyId, query.source, query.campaign]),
    )
    .digest("hex");
  const after = decodeCursor(query.cursor, binding);
  const persistedAccess = await database.query<{ authorized: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM identity.organization_resource_links link
      WHERE link.organization_id=$1::uuid AND link.product='marketplace' AND link.status='active'
       AND link.resource_type=CASE WHEN $2='creator' THEN 'creator_profile' ELSE 'hotel_profile' END
       AND link.resource_id=$3 AND link.relationship=ANY($4::text[])) AS authorized`,
    [scope.organizationId, scope.kind, scope.resourceId, scope.relationships],
  );
  if (!persistedAccess.rows[0]?.authorized)
    throw new Error("affiliate performance scope unavailable");
  const agreements = await database.query<AgreementRow>(
    `SELECT agreement.id::text AS "agreementId",agreement.property_id::text AS "propertyId",
      property.display_name AS "propertyName",agreement.creator_profile_id::text AS "creatorProfileId"
     FROM marketplace.affiliate_agreements agreement
     JOIN hotel_catalog.properties property ON property.id=agreement.property_id
     WHERE (($1='creator' AND agreement.creator_profile_id=$2::uuid AND agreement.creator_organization_id=$3::uuid)
       OR ($1='hotel' AND agreement.property_id=$2::uuid AND agreement.hotel_organization_id=$3::uuid))
       AND ($4::text IS NULL OR (agreement.property_id::text,agreement.id::text)>($4,$5::text))
       AND ($7::uuid IS NULL OR agreement.property_id=$7::uuid)
     ORDER BY agreement.property_id,agreement.id LIMIT $6`,
    [
      scope.kind,
      scope.resourceId,
      scope.organizationId,
      after?.[0] ?? null,
      after?.[1] ?? null,
      query.limit + 1,
      query.propertyId ?? null,
    ],
  );
  const pageRows = agreements.rows.slice(0, query.limit);
  const ids = pageRows.map((row) => row.agreementId);
  const propertyIds = [...new Set(pageRows.map((row) => row.propertyId))];
  const [clicks, bookings, earningAttributions] = ids.length
    ? await Promise.all([
        database.query<ClickRow>(
          `SELECT link.agreement_id::text AS "agreementId",occurrence.source,
            occurrence.campaign_label AS campaign,count(*)::int AS count
           FROM marketplace.affiliate_click_occurrences occurrence
           JOIN marketplace.affiliate_links link ON link.id=occurrence.link_id
           WHERE link.agreement_id=ANY($1::uuid[]) AND occurrence.synthetic=FALSE
            AND occurrence.clicked_at>=$2::timestamptz AND occurrence.clicked_at<$3::timestamptz
            AND ($4::text IS NULL OR occurrence.source=$4)
            AND ($5::text IS NULL OR occurrence.campaign_label=$5)
           GROUP BY link.agreement_id,occurrence.source,occurrence.campaign_label`,
          [ids, query.from, query.to, query.source ?? null, query.campaign ?? null],
        ),
        readAffiliateAttributedBookings(database, {
          propertyIds,
          agreementIds: ids,
          from: query.from,
          to: query.to,
          source: query.source,
          campaign: query.campaign,
        }),
        query.source || query.campaign
          ? readAffiliateAttributedBookings(database, {
              propertyIds,
              agreementIds: ids,
              source: query.source,
              campaign: query.campaign,
            })
          : Promise.resolve(undefined),
      ])
    : [{ rows: [] }, [], undefined];
  const earnings = ids.length
    ? await readLatestAffiliateEarningOutcomes(database, {
        agreementIds: ids,
        from: query.from,
        to: query.to,
        ...(earningAttributions && {
          bookingKeys: earningAttributions.map((row) => `${row.propertyId}:${row.bookingId}`),
        }),
      })
    : [];

  const partnerships = pageRows.map((agreement) =>
    assemble(agreement, clicks.rows, bookings, earnings),
  );
  const last = pageRows.at(-1);
  return {
    coverage: "available",
    readAt: new Date().toISOString(),
    period: {
      from: query.from,
      to: query.to,
      clickCohort: "clicked_at",
      bookingCohort: "booked_at",
      earningCohort: "latest_outcome_recorded_at",
    },
    filters: {
      propertyId: query.propertyId ?? null,
      source: query.source ?? null,
      campaign: query.campaign ?? null,
    },
    partnerships,
    nextCursor:
      agreements.rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify([binding, query.from, query.to, last.propertyId, last.agreementId]),
          ).toString("base64url")
        : null,
  };
}

async function authorize(context: RequestContext, propertyId?: string) {
  requirePermission(context, "marketplace.collaboration.read");
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active"
  )
    throw new Error("affiliate performance scope unavailable");
  const creator = context.selectedOrganization.kind === "creator_workspace";
  if (!creator && context.selectedOrganization.kind !== "hotel_group")
    throw new Error("affiliate performance scope unavailable");
  const resources = context.linkedResources.filter(
    (link) =>
      link.product === "marketplace" &&
      link.status === "active" &&
      link.resourceType === (creator ? "creator_profile" : "hotel_profile") &&
      (creator
        ? link.relationship === "owner"
        : ["owner", "operator"].includes(link.relationship)) &&
      (!propertyId || creator || link.resourceId === propertyId),
  );
  if (resources.length !== 1 || (!creator && !propertyId))
    throw new Error("affiliate performance scope unavailable");
  const resource = resources[0]!;
  const relationships = creator ? (["owner"] as const) : (["owner", "operator"] as const);
  requireResourceAccess(context, {
    permission: "marketplace.collaboration.read",
    resource: { ...resource, allowedRelationships: [...relationships] },
  });
  if (!creator) {
    requireActiveEntitlement(context, {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      resource,
    });
    await requirePropertyAccess(
      context,
      { findMembershipPropertyScope: async () => null },
      {
        propertyId: resource.resourceId,
        targetResource: { product: "marketplace", resourceType: "hotel_profile" },
        allowedRelationships: [...relationships],
      },
    );
  }
  return {
    kind: creator ? "creator" : "hotel",
    resourceId: resource.resourceId,
    organizationId: context.selectedOrganization.organizationId,
    relationships: [...relationships],
  };
}

function assemble(
  agreement: AgreementRow,
  clicks: ClickRow[],
  bookings: AffiliateAttributedBooking[],
  earnings: FinanceAffiliateEarningOutcome[],
): AffiliatePerformancePartnership {
  const ownClicks = clicks.filter((row) => row.agreementId === agreement.agreementId);
  const ownEarnings = earnings.filter((row) => row.agreementId === agreement.agreementId);
  const totals = new Map<
    string,
    { currencyMinorUnit: number; calculated: bigint; adjustment: bigint }
  >();
  const states = { calculated: 0, pending: 0, needsReview: 0 };
  let freshness: "current" | "stale" | "unknown" = ownEarnings.length ? "current" : "unknown";
  for (const row of ownEarnings) {
    states[row.status === "needs_review" ? "needsReview" : row.status]++;
    if (row.freshness === "unknown") freshness = "unknown";
    else if (freshness !== "unknown" && row.freshness === "stale") freshness = "stale";
    if (row.status !== "calculated" || !row.amount || row.adjustmentMinor === undefined) continue;
    const key = `${row.amount.currency}:${row.amount.currencyMinorUnit}`;
    const total = totals.get(key) ?? {
      currencyMinorUnit: row.amount.currencyMinorUnit,
      calculated: 0n,
      adjustment: 0n,
    };
    total.calculated += BigInt(row.amount.commissionMinor);
    total.adjustment += BigInt(row.adjustmentMinor);
    totals.set(key, total);
  }
  const sum = (key: "source" | "campaign") =>
    [...new Set(ownClicks.map((row) => row[key] ?? ""))].map((value) => ({
      [key]: value || null,
      clicks: ownClicks
        .filter((row) => (row[key] ?? "") === value)
        .reduce((n, row) => n + row.count, 0),
    }));
  return {
    ...agreement,
    clicks: ownClicks.reduce((n, row) => n + row.count, 0),
    bookings: bookings.filter((row) => row.agreementId === agreement.agreementId).length,
    stays: { total: ownEarnings.length, ...states },
    commissions: [...totals.entries()].map(([key, value]) => ({
      currency: key.split(":")[0]!,
      currencyMinorUnit: value.currencyMinorUnit,
      calculatedMinor: value.calculated.toString(),
      adjustmentMinor: value.adjustment.toString(),
    })),
    sources: sum("source") as AffiliatePerformancePartnership["sources"],
    campaigns: sum("campaign") as AffiliatePerformancePartnership["campaigns"],
    freshness,
  };
}

function decodeCursor(cursor: string | undefined, binding: string): [string, string] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 5 &&
      value[0] === binding &&
      value.slice(1).every((item) => typeof item === "string")
    )
      return [value[3] as string, value[4] as string];
  } catch {}
  throw new Error("invalid affiliate performance cursor");
}
