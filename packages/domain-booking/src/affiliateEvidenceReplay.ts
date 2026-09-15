import { createHash } from "node:crypto";
import {
  matchesAffiliateEvidenceBinding,
  parseAffiliateBookingEvidence,
  type AffiliateEvidenceBinding,
} from "./affiliateBookingEvidence.js";

export type AffiliateEvidenceReplayIdentity = {
  deliveryKey: string;
  factDigest: string;
};

/** Stable JSON for validated JSON-only data; array order remains significant. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * Prepare identity only, after the caller resolves fresh authorized server metadata.
 * Same delivery key + digest is a fact replay; same key + different digest conflicts.
 * No durable receipt, evidence-authority approval or provenance deduplication occurs.
 */
export function identifyAffiliateEvidenceReplay(
  input: unknown,
  binding: AffiliateEvidenceBinding,
  evidence: Parameters<typeof matchesAffiliateEvidenceBinding>[2],
  mappingVersion: string,
): AffiliateEvidenceReplayIdentity | null {
  const observation = parseAffiliateBookingEvidence(input);
  if (
    !observation ||
    !matchesAffiliateEvidenceBinding(observation, binding, evidence) ||
    typeof mappingVersion !== "string" ||
    !mappingVersion.length ||
    mappingVersion.length > 256 ||
    mappingVersion.trim() !== mappingVersion ||
    /[\p{Cc}\p{Cf}]/u.test(mappingVersion)
  )
    return null;

  const scope = {
    organizationId: binding.organizationId,
    connectionId: binding.connectionId,
    propertyId: binding.propertyId,
    booking: observation.booking,
  };
  const facts = observation.facts; // Detached by the parser; never mutate caller input.
  if (facts.actualDepartureAt)
    facts.actualDepartureAt = new Date(facts.actualDepartureAt).toISOString();
  for (const money of [facts.bookingAmount, facts.refundTotal]) {
    if (money?.amount.includes("."))
      money.amount = money.amount.replace(/0+$/, "").replace(/\.$/, "");
  }
  return {
    deliveryKey: hash({
      identityVersion: "affiliate-evidence-delivery.v1",
      scope,
      sourceEventKey: observation.sourceEventKey,
    }),
    factDigest: hash({
      identityVersion: "affiliate-evidence-facts.v1",
      contractVersion: observation.contractVersion,
      scope,
      mappingVersion,
      sourceRevision: observation.sourceRevision,
      supersedesEventKey: observation.supersedesEventKey,
      sourceOccurredAt: observation.sourceOccurredAt
        ? new Date(observation.sourceOccurredAt).toISOString()
        : null,
      facts,
    }),
  };
}
