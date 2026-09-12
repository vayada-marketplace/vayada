import type { PoolClient } from "pg";
import { readChannexCreatedRateIdentity } from "../integrations/channexOfferConfiguration.js";

/** Interprets tagged evidence; parsing JSON alone never establishes creation success. */
export function readChannexCreationReceiptIdentity(receipt: {
  outcome: unknown;
  http_status: unknown;
  has_warnings: unknown;
  identity_evidence: unknown;
}) {
  if (
    receipt.outcome !== "complete_json" ||
    receipt.http_status !== 201 ||
    receipt.has_warnings !== false
  )
    return undefined;
  try {
    const evidence = receipt.identity_evidence as Record<
      string,
      { kind?: unknown; value?: unknown }
    >;
    const value = (key: string) => {
      const field = evidence[key];
      if (field?.kind === "missing") return undefined;
      if (field?.kind !== "value" || typeof field.value !== "string") throw new Error("invalid");
      return field.value;
    };
    const container = (key: string) => {
      const kind = evidence[key]?.kind;
      if (kind !== "object" && kind !== "missing") throw new Error("invalid");
      return kind === "object";
    };
    if (!container("data")) return undefined;
    const attributes = {
      id: value("attributeRateId"),
      property_id: value("propertyId"),
      room_type_id: value("roomId"),
    };
    if (!container("attributes") && Object.values(attributes).some((v) => v !== undefined))
      return undefined;
    const relation = (key: string, idKey: string) => {
      const present = container(key),
        id = value(idKey);
      if (!present && id !== undefined) throw new Error("invalid");
      return present ? { data: { id } } : undefined;
    };
    const relationships = {
      property: relation("propertyRelationship", "relatedPropertyId"),
      room_type: relation("roomRelationship", "relatedRoomId"),
    };
    if (!container("relationships") && Object.values(relationships).some((v) => v !== undefined))
      return undefined;
    const identity = readChannexCreatedRateIdentity({
      data: { type: value("type"), id: value("rateId"), attributes, relationships },
    });
    return identity;
  } catch {
    return undefined;
  }
}

export function matchesChannexCreationReceipt(
  receipt: Parameters<typeof readChannexCreationReceiptIdentity>[0],
  expected: { externalPropertyId: string; externalRoomTypeId: string; externalRatePlanId: string },
) {
  const identity = readChannexCreationReceiptIdentity(receipt);
  return (
    !!identity &&
    identity.externalPropertyId === expected.externalPropertyId &&
    identity.externalRoomTypeId === expected.externalRoomTypeId &&
    identity.externalRatePlanId === expected.externalRatePlanId
  );
}

/** Caller holds the target row lock before this query, as receipt capture does.
 * No history is cleared; the local 1000-row work ceiling also fails closed.
 */
export async function channexCreationReceiptsResolved(
  client: PoolClient,
  targetId: string,
  freshAttemptId: string | null = null,
) {
  const rows = (
    await client.query(
      `SELECT a.state,a.job_attempt_id,a.worker_id,a.external_property_id,a.external_room_type_id,a.external_rate_plan_id,
       r.id AS receipt_id,r.outcome,r.http_status,r.has_warnings,r.identity_evidence
     FROM pms.channex_offer_create_attempts a
     LEFT JOIN pms.channex_offer_create_receipts r ON r.attempt_id=a.id
     WHERE a.target_id=$1 AND ($2::uuid IS NULL OR a.id<>$2::uuid) LIMIT 1001`,
      [targetId, freshAttemptId],
    )
  ).rows;
  return (
    rows.length <= 1000 &&
    rows.every(
      (row) =>
        row.state === "identified" &&
        row.job_attempt_id &&
        row.worker_id &&
        row.receipt_id &&
        matchesChannexCreationReceipt(row, {
          externalPropertyId: row.external_property_id,
          externalRoomTypeId: row.external_room_type_id,
          externalRatePlanId: row.external_rate_plan_id,
        }),
    )
  );
}
