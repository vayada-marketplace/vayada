import type { ReplyState, ReviewIdentity } from "./channexReviewReplies.js";

export const guestRatingKeys = ["respectHouseRules", "communication", "cleanliness"] as const;
export type GuestReviewDraft = Record<(typeof guestRatingKeys)[number], number> & {
  publicReview: string;
  privateReview: string;
  recommended: boolean;
};
export type GuestReviewStatus = { state: ReplyState; reason?: string; draft?: GuestReviewDraft };
export type GuestReviewOpportunity = GuestReviewStatus & {
  reviewId: string;
  guestName: string;
  reservationCode: string;
};
export type GuestReviewProvider = {
  list(
    propertyId: string,
    page: number,
  ): Promise<{ items: GuestReviewOpportunity[]; more: boolean }>;
  check(identity: ReviewIdentity): Promise<GuestReviewOpportunity>;
  send(identity: ReviewIdentity, draft: GuestReviewDraft): Promise<GuestReviewStatus>;
};

export function parseGuestReviewDraft(value: unknown): GuestReviewDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const draft = value as GuestReviewDraft;
  if (
    guestRatingKeys.some((key) => !Number.isInteger(draft[key]) || draft[key] < 1 || draft[key] > 5)
  )
    return;
  if (typeof draft.recommended !== "boolean") return;
  for (const text of [draft.publicReview, draft.privateReview])
    if (
      typeof text !== "string" ||
      text.length > 10000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
    )
      return;
  if (!draft.publicReview.trim()) return;
  return {
    respectHouseRules: draft.respectHouseRules,
    communication: draft.communication,
    cleanliness: draft.cleanliness,
    publicReview: draft.publicReview.trim(),
    privateReview: draft.privateReview.trim(),
    recommended: draft.recommended,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function opportunity(value: unknown, identity: ReviewIdentity): GuestReviewOpportunity {
  const data = record(value),
    attributes = record(data.attributes);
  const result = {
    reviewId: identity.reviewId,
    guestName: text(attributes.guest_name),
    reservationCode: text(attributes.ota_reservation_id),
  };
  const property = record(record(record(data.relationships).property).data).id;
  if (data.id !== identity.reviewId || property !== identity.externalPropertyId)
    return {
      ...result,
      guestName: "",
      reservationCode: "",
      state: "unavailable",
      reason: "identity_mismatch",
    };
  if (text(attributes.ota).toLowerCase() !== "airbnb")
    return { ...result, state: "unavailable", reason: "unsupported_channel" };
  const guestReview = record(attributes.reply).guest_review;
  if (guestReview && typeof guestReview === "object" && !Array.isArray(guestReview))
    return { ...result, state: "accepted" };
  const reason =
    attributes.is_expired === true
      ? "expired"
      : attributes.is_expired !== false
        ? "eligibility_unknown"
        : attributes.is_hidden !== true
          ? "not_eligible"
          : !result.guestName || !result.reservationCode
            ? "stay_context_missing"
            : undefined;
  return { ...result, state: reason ? "unavailable" : "ready", ...(reason ? { reason } : {}) };
}

export function createChannexGuestReviews(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): GuestReviewProvider {
  const request = config.fetch ?? fetch;
  async function call(path: string, body?: unknown) {
    return request(new URL(`/api/v1/${path}`, config.apiBaseUrl), {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { "user-api-key": config.apiKey, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  return {
    async list(externalPropertyId, page) {
      const query = new URLSearchParams({
        "filter[property_id]": externalPropertyId,
        "pagination[page]": String(page),
        "pagination[limit]": "50",
      });
      const response = await call(`reviews?${query}`);
      if (!response.ok) throw new Error("guest_reviews_unavailable");
      const payload = record(await response.json());
      if (!Array.isArray(payload.data)) throw new Error("guest_reviews_unavailable");
      const items = payload.data
        .map((data) =>
          opportunity(data, {
            reviewId: text(record(data).id),
            externalPropertyId,
          }),
        )
        .filter(
          (item) =>
            item.reviewId &&
            !["identity_mismatch", "unsupported_channel"].includes(item.reason ?? ""),
        );
      const total = record(payload.meta).total;
      return {
        items,
        more: typeof total === "number" ? page * 50 < total : payload.data.length === 50,
      };
    },
    async check(identity) {
      const unavailable: GuestReviewOpportunity = {
        reviewId: identity.reviewId,
        guestName: "",
        reservationCode: "",
        state: "unavailable",
        reason: "provider_unavailable",
      };
      try {
        const response = await call(`reviews/${encodeURIComponent(identity.reviewId)}`);
        return response.ok
          ? opportunity(record(await response.json()).data, identity)
          : unavailable;
      } catch {
        return unavailable;
      }
    },
    async send(identity, draft) {
      try {
        const response = await call(
          `reviews/${encodeURIComponent(identity.reviewId)}/guest_review`,
          {
            review: {
              scores: [
                { category: "respect_house_rules", rating: draft.respectHouseRules },
                { category: "communication", rating: draft.communication },
                { category: "cleanliness", rating: draft.cleanliness },
              ],
              public_review: draft.publicReview,
              private_review: draft.privateReview,
              is_reviewee_recommended: draft.recommended,
            },
          },
        );
        if (!response.ok)
          return {
            state: [400, 401, 403, 404, 422, 429].includes(response.status)
              ? "failed"
              : "uncertain",
            reason: "provider_rejected",
          };
        const payload = record(await response.json());
        if (payload.success === true) return { state: "accepted" };
        if (opportunity(payload.data, identity).state === "accepted") return { state: "accepted" };
      } catch {
        /* A lost response cannot authorize a second POST. */
      }
      return { state: "uncertain", reason: "confirmation_pending" };
    },
  };
}
