import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

export type PmsReview = {
  reviewId: string;
  channel: string | null;
  guestDisplayName: string | null;
  rating: string | null;
  body: string;
  replyBody: string | null;
  reviewedAt: string | null;
  updatedAt: string;
  replySubmission?: ReviewReplyStatus | null;
};

export function listPmsReviews(
  propertyId: string,
  filters: { channel?: string; minRating?: number } = {},
): Promise<{
  items: PmsReview[];
  pagination: { total: number; limit: number; offset: number };
}> {
  const query = new URLSearchParams();
  if (filters.channel) query.set("channel", filters.channel);
  if (filters.minRating !== undefined) query.set("minRating", String(filters.minRating));
  return pmsOperationsClient.get(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/reviews?${query}`,
    pmsOperationsRequestOptions,
  );
}

export type ReviewReplyStatus = {
  state: "ready" | "accepted" | "failed" | "uncertain" | "unavailable";
  reason?: string;
  replyBody?: string;
  draft?: string;
};
export function checkReviewReply(propertyId: string, reviewId: string): Promise<ReviewReplyStatus> {
  return pmsOperationsClient.get(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/reviews/${encodeURIComponent(reviewId)}/reply`,
    pmsOperationsRequestOptions,
  );
}
export function submitReviewReply(
  propertyId: string,
  reviewId: string,
  text: string,
): Promise<ReviewReplyStatus> {
  return pmsOperationsClient.post(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/reviews/${encodeURIComponent(reviewId)}/reply`,
    { text },
    pmsOperationsRequestOptions,
  );
}

export type GuestReviewDraft = {
  respectHouseRules: number;
  communication: number;
  cleanliness: number;
  publicReview: string;
  privateReview: string;
  recommended: boolean;
};
export type GuestReviewOpportunity = {
  reviewId: string;
  guestName: string;
  reservationCode: string;
  state: ReviewReplyStatus["state"];
  reason?: string;
  draft?: GuestReviewDraft;
};
const guestReviewPath = (propertyId: string) =>
  `/api/pms/properties/${encodeURIComponent(propertyId)}/guest-reviews`;
export function listGuestReviews(
  propertyId: string,
  page: number,
): Promise<{
  items: GuestReviewOpportunity[];
  stored: GuestReviewOpportunity[];
  more: boolean;
  unavailable: boolean;
}> {
  return pmsOperationsClient.get(
    `${guestReviewPath(propertyId)}?page=${page}`,
    pmsOperationsRequestOptions,
  );
}
export function checkGuestReview(
  propertyId: string,
  reviewId: string,
): Promise<GuestReviewOpportunity> {
  return pmsOperationsClient.get(
    `${guestReviewPath(propertyId)}/${encodeURIComponent(reviewId)}`,
    pmsOperationsRequestOptions,
  );
}
export function submitGuestReview(
  propertyId: string,
  reviewId: string,
  draft: GuestReviewDraft,
): Promise<GuestReviewOpportunity> {
  return pmsOperationsClient.post(
    `${guestReviewPath(propertyId)}/${encodeURIComponent(reviewId)}`,
    draft,
    pmsOperationsRequestOptions,
  );
}
