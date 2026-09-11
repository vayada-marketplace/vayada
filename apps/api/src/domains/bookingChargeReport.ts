import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RequestContext } from "@vayada/backend-auth";
import { requireActiveEntitlement, requireResourceAccess } from "@vayada/backend-authorization";
import { decomposeNativeCheckoutCharge } from "@vayada/domain-booking";

type Input = {
  propertyId: string;
  bookingId: string;
  sourceRevision: string;
  expectedReportId: string | null;
  reportedItemReference: string;
  components: { accommodation: string; tax: string; extras: string; other: string };
};
type Runtime = {
  freshContext(): Promise<RequestContext>;
  environment: "local" | "sandbox" | "production";
  purpose: "diagnostic" | "live";
  connectionReference: string;
};
type Result =
  | { ok: true; reportId: string; replayed: boolean; status: "unverified" }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "scope_unavailable"
        | "source_unavailable"
        | "revision_conflict"
        | "idempotency_conflict";
    };
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= 200;
function authorize(context: RequestContext, propertyId: string): boolean {
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group"
  )
    return false;
  const resource = {
    product: "booking" as const,
    resourceType: "booking_hotel" as const,
    resourceId: propertyId,
  };
  requireResourceAccess(context, {
    permission: "booking.settings.manage",
    resource: { ...resource, allowedRelationships: ["owner", "operator"] },
  });
  requireActiveEntitlement(context, { product: "booking", key: "booking-engine", resource });
  return true;
}

/** Internal hotel-report command. Runtime identity/purpose must be server-owned.
 * Captures claims against an unchanged original native EUR price, not accepted
 * item allocation, verified tax, collection or earnings. No HTTP/Finance caller.
 */
export async function submitBookingChargeReport(
  pool: pg.Pool,
  input: Input,
  runtime: Runtime,
): Promise<Result> {
  input = { ...input, components: { ...input?.components } };
  const amounts = input.components;
  if (
    !uuid(input?.propertyId) ||
    !uuid(input.bookingId) ||
    !text(input.sourceRevision) ||
    !text(input.reportedItemReference) ||
    !(input.expectedReportId === null || uuid(input.expectedReportId)) ||
    !amounts ||
    Object.keys(amounts).sort().join(",") !== "accommodation,extras,other,tax" ||
    !Object.values(amounts).every((v) => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v)) ||
    !["local", "sandbox", "production"].includes(runtime.environment) ||
    !["diagnostic", "live"].includes(runtime.purpose) ||
    (runtime.purpose === "live" && runtime.environment !== "production") ||
    !text(runtime.connectionReference)
  )
    return { ok: false, code: "invalid_request" };
  const propertyId = input.propertyId.toLowerCase(),
    bookingId = input.bookingId.toLowerCase();
  const expected = input.expectedReportId?.toLowerCase() ?? null;
  const context = await runtime.freshContext();
  if (!authorize(context, propertyId)) return { ok: false, code: "scope_unavailable" };
  const organizationId = context.selectedOrganization.organizationId,
    actorId = context.actor.internalUserId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const fail = async (code: Extract<Result, { ok: false }>["code"]): Promise<Result> => {
      await client.query("ROLLBACK");
      return { ok: false, code };
    };
    const scope = await client.query(
      `SELECT p.id FROM hotel_catalog.properties p JOIN identity.organization_resource_links l ON l.resource_id=p.id::text
      WHERE p.id=$1 AND p.profile_status<>'disabled' AND l.organization_id=$2 AND l.product='booking' AND l.resource_type='booking_hotel'
      AND l.status='active' AND l.relationship IN ('owner','operator') ORDER BY l.id FOR UPDATE OF p,l`,
      [propertyId, organizationId],
    );
    if (!scope.rowCount) return await fail("scope_unavailable");
    const row = (
      await client.query(
        `SELECT s.*,b.edit_revision,b.room_count,b.currency AS booking_currency,b.quote_session_id,
      b.booking_metadata ?| ARRAY['lastHostEditPreviewId','lastAcceptedChangeRequestId'] AS amended,
      (b.total_amount*100)::numeric(20,0)::text AS current_total_minor,
      EXISTS(SELECT 1 FROM booking.affiliate_validation_booking_bindings v WHERE v.booking_id=b.id)
        OR EXISTS(SELECT 1 FROM booking.affiliate_validation_quote_bindings v WHERE v.quote_id=s.quote_id) AS diagnostic
      FROM booking.guest_bookings b JOIN booking.original_charge_snapshots s ON s.booking_id=b.id
      WHERE b.id=$1 AND b.property_id=$2 FOR UPDATE OF b`,
        [bookingId, propertyId],
      )
    ).rows[0];
    const fresh = await runtime.freshContext();
    if (
      !authorize(fresh, propertyId) ||
      fresh.actor.internalUserId !== actorId ||
      fresh.selectedOrganization.organizationId !== organizationId
    )
      return await fail("scope_unavailable");
    if (!text(fresh.audit.requestId)) return await fail("invalid_request");
    if (
      !row ||
      row.edit_revision !== 0 ||
      row.amended ||
      row.room_count !== 1 ||
      row.booking_currency !== "EUR" ||
      row.currency !== "EUR" ||
      row.quote_session_id !== row.quote_id ||
      (runtime.purpose === "live" && row.diagnostic)
    )
      return await fail("source_unavailable");
    const source = decomposeNativeCheckoutCharge({
      contractVersion: row.contract_version,
      totals: row.totals,
      selectedOffer: row.selected_offer,
    });
    if (
      source.status !== "reported_components" ||
      source.currency !== "EUR" ||
      source.totalMinor !== row.current_total_minor
    )
      return await fail("source_unavailable");
    const total = Object.values(amounts)
      .reduce((sum, v) => sum + BigInt(v), 0n)
      .toString();
    if (total !== source.totalMinor) return await fail("invalid_request");
    const stream = [
      propertyId,
      runtime.connectionReference,
      runtime.environment,
      runtime.purpose,
      bookingId,
    ];
    const reportScope = `SELECT * FROM booking.charge_breakdown_reports WHERE property_id=$1 AND source_kind='hotel_reported'
      AND source_connection=$2 AND environment=$3 AND purpose=$4 AND source_record=$5`;
    const prior = (
      await client.query(`${reportScope} AND source_revision=$6`, [...stream, input.sourceRevision])
    ).rows[0];
    if (prior) {
      const same =
        prior.booking_id === bookingId &&
        prior.actor_user_id === actorId &&
        prior.organization_id === organizationId &&
        prior.supersedes_id === expected &&
        prior.source_contract === "native-hotel-charge-report.v1" &&
        prior.reported_charge_reference === row.quote_id &&
        prior.reported_item_reference === input.reportedItemReference &&
        prior.currency === "EUR" &&
        prior.minor_unit_scale === 2 &&
        prior.accommodation_minor === amounts.accommodation &&
        prior.tax_minor === amounts.tax &&
        prior.extras_minor === amounts.extras &&
        prior.other_minor === amounts.other &&
        prior.total_minor === total;
      if (!same) return await fail("idempotency_conflict");
      await client.query("COMMIT");
      return { ok: true, reportId: prior.id, replayed: true, status: "unverified" };
    }
    const head = (await client.query(`${reportScope} ORDER BY revision DESC LIMIT 1`, stream))
      .rows[0];
    if ((head?.id ?? null) !== expected || (head && head.revision >= 2147483647))
      return await fail("revision_conflict");
    const reportId = randomUUID();
    await client.query(
      `INSERT INTO booking.charge_breakdown_reports
      (id,booking_id,property_id,contract_version,evidence_status,purpose,environment,source_kind,source_connection,source_record,source_revision,source_contract,
       reported_charge_reference,reported_item_reference,currency,minor_unit_scale,accommodation_minor,tax_minor,extras_minor,other_minor,total_minor,
       revision,supersedes_id,actor_user_id,organization_id,request_id,observed_at)
      VALUES($1,$2::uuid,$3,'booking-charge-report.v1','unverified',$4,$5,'hotel_reported',$6,$2::text,$7,'native-hotel-charge-report.v1',
       $8,$9,'EUR',2,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,clock_timestamp())`,
      [
        reportId,
        bookingId,
        propertyId,
        runtime.purpose,
        runtime.environment,
        runtime.connectionReference,
        input.sourceRevision,
        row.quote_id,
        input.reportedItemReference,
        amounts.accommodation,
        amounts.tax,
        amounts.extras,
        amounts.other,
        total,
        (head?.revision ?? 0) + 1,
        expected,
        actorId,
        organizationId,
        fresh.audit.requestId,
      ],
    );
    await client.query("COMMIT");
    return { ok: true, reportId, replayed: false, status: "unverified" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
