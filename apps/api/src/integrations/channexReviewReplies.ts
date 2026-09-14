export type ReplyState = "ready" | "accepted" | "failed" | "uncertain" | "unavailable";
export type ReviewReplyResult = { state: ReplyState; reason?: string; replyBody?: string };
export type ReviewIdentity = { reviewId: string; externalPropertyId: string };
export type ReviewReplyProvider = {
  check(identity: ReviewIdentity): Promise<ReviewReplyResult>;
  send(identity: ReviewIdentity, text: string): Promise<ReviewReplyResult>;
};

export function createChannexReviewReplies(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): ReviewReplyProvider {
  const request = config.fetch ?? fetch;
  async function call(identity: ReviewIdentity, text?: string): Promise<ReviewReplyResult> {
    const writing = text !== undefined;
    try {
      const response = await request(
        new URL(
          `/api/v1/reviews/${encodeURIComponent(identity.reviewId)}${writing ? "/reply" : ""}`,
          config.apiBaseUrl,
        ),
        {
          method: writing ? "POST" : "GET",
          headers: { "user-api-key": config.apiKey, "content-type": "application/json" },
          ...(writing ? { body: JSON.stringify({ reply: { reply: text } }) } : {}),
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        },
      );
      if (!response.ok) {
        const reason = [401, 403].includes(response.status)
          ? "application_access_unavailable"
          : response.status === 404
            ? "review_unavailable"
            : "provider_rejected";
        return {
          state: writing
            ? [400, 401, 403, 404, 422, 429].includes(response.status)
              ? "failed"
              : "uncertain"
            : "unavailable",
          reason,
        };
      }
      const { data } = (await response.json()) as {
        data?: {
          id?: string;
          attributes?: {
            ota?: string;
            content?: string;
            is_hidden?: boolean;
            is_replied?: boolean;
            is_expired?: boolean;
            reply?: string | { reply?: string; guest_review?: unknown };
          };
          relationships?: { property?: { data?: { id?: string } } };
        };
      };
      if (
        data?.id !== identity.reviewId ||
        data.relationships?.property?.data?.id !== identity.externalPropertyId
      )
        return {
          state: writing ? "uncertain" : "unavailable",
          reason: "provider_identity_mismatch",
        };
      const review = data.attributes;
      const reply = typeof review?.reply === "string" ? review.reply : review?.reply?.reply;
      const replyBody = typeof reply === "string" && reply.trim() ? reply : undefined;
      if (review?.is_replied === true || replyBody)
        return { state: "accepted", ...(replyBody ? { replyBody } : {}) };
      if (writing) return { state: "uncertain", reason: "confirmation_missing" };
      const channel = review?.ota?.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const reason = !["bookingcom", "airbnb", "expedia"].includes(channel ?? "")
        ? "unsupported_channel"
        : review?.is_replied !== false
          ? "confirmation_missing"
          : review?.is_hidden !== false
            ? "review_visibility_unconfirmed"
            : review?.is_expired !== false
              ? "review_unavailable"
              : !review?.content?.trim()
                ? "score_only_review"
                : undefined;
      return reason ? { state: "unavailable", reason } : { state: "ready" };
    } catch {
      return { state: writing ? "uncertain" : "unavailable", reason: "provider_unreachable" };
    }
  }
  return { check: (identity) => call(identity), send: (identity, text) => call(identity, text) };
}
