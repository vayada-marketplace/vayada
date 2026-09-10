/** Trusted application evidence only. Not a public click/conversion request schema. */
export type AffiliateClickCandidate = Readonly<{
  bookingId: string;
  propertyId: string;
  clickId: string;
  linkId: string;
  creatorProfileId: string;
  agreementId: string;
  termsVersionId: string;
  clickedAt: string;
  attributionWindowDays: number;
  eligibility: "eligible" | "ineligible" | "unknown";
  isTest: boolean;
}>;
export type AffiliateAttributionResult =
  | { status: "pending"; reason: "incomplete_evidence" }
  | { status: "unattributed"; reason: "no_eligible_click" }
  | {
      status: "needs_review";
      reason:
        | "invalid_evidence"
        | "conflicting_click"
        | "ambiguous_last_click"
        | "eligibility_unknown";
    }
  | {
      status: "attributed";
      bookingId: string;
      propertyId: string;
      clickId: string;
      linkId: string;
      creatorProfileId: string;
      agreementId: string;
      termsVersionId: string;
    };
const reference = (value: string) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
function utcTime(value: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  return new Date(time).toISOString() ===
    (value.includes(".") ? value : value.replace("Z", ".000Z"))
    ? time
    : NaN;
}

/** Selects credit only; never establishes completion, commission or permission to pay.
 * Callers must resolve authenticated booking matches and exact accepted agreement terms.
 * Complete evidence means the candidate set is exhaustive for this booking and scope. */
export function selectLastEligibleAffiliateClick(input: {
  bookingId: string;
  propertyId: string;
  bookedAt: string;
  evidenceComplete: boolean;
  candidates: readonly AffiliateClickCandidate[];
}): AffiliateAttributionResult {
  const invalid = { status: "needs_review", reason: "invalid_evidence" } as const;
  const bookedAt = utcTime(input.bookedAt);
  if (!reference(input.bookingId) || !reference(input.propertyId) || !Number.isFinite(bookedAt))
    return invalid;
  if (input.evidenceComplete !== true) return { status: "pending", reason: "incomplete_evidence" };
  const seen = new Map<string, string>();
  let latest = -Infinity;
  let winners: AffiliateClickCandidate[] = [];
  for (const candidate of input.candidates) {
    if (candidate.bookingId !== input.bookingId || candidate.propertyId !== input.propertyId)
      continue;
    const clickedAt = utcTime(candidate.clickedAt);
    const duration = candidate.attributionWindowDays * 86_400_000;
    if (
      ![
        candidate.clickId,
        candidate.linkId,
        candidate.creatorProfileId,
        candidate.agreementId,
        candidate.termsVersionId,
      ].every(reference) ||
      !Number.isFinite(clickedAt) ||
      !Number.isSafeInteger(candidate.attributionWindowDays) ||
      candidate.attributionWindowDays < 1 ||
      !Number.isSafeInteger(duration) ||
      typeof candidate.isTest !== "boolean" ||
      !["eligible", "ineligible", "unknown"].includes(candidate.eligibility)
    )
      return invalid;
    const fingerprint = JSON.stringify([
      candidate.linkId,
      candidate.creatorProfileId,
      candidate.agreementId,
      candidate.termsVersionId,
      clickedAt,
      duration,
      candidate.eligibility,
      candidate.isTest,
    ]);
    const prior = seen.get(candidate.clickId);
    if (prior !== undefined) {
      if (prior !== fingerprint) return { status: "needs_review", reason: "conflicting_click" };
      continue;
    }
    seen.set(candidate.clickId, fingerprint);
    const elapsed = bookedAt - clickedAt;
    if (
      candidate.isTest ||
      candidate.eligibility === "ineligible" ||
      elapsed < 0 ||
      elapsed > duration
    )
      continue;
    if (candidate.eligibility === "unknown")
      return { status: "needs_review", reason: "eligibility_unknown" };
    if (clickedAt > latest) {
      latest = clickedAt;
      winners = [candidate];
    } else if (clickedAt === latest) winners.push(candidate);
  }
  if (!winners.length) return { status: "unattributed", reason: "no_eligible_click" };
  if (winners.length > 1) return { status: "needs_review", reason: "ambiguous_last_click" };
  const winner = winners[0]!;
  return {
    status: "attributed",
    bookingId: input.bookingId,
    propertyId: input.propertyId,
    clickId: winner.clickId,
    linkId: winner.linkId,
    creatorProfileId: winner.creatorProfileId,
    agreementId: winner.agreementId,
    termsVersionId: winner.termsVersionId,
  };
}
