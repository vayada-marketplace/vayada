import { createHash } from "node:crypto";
import { z } from "zod";

const scopeSchema = z
  .object({
    eventId: z.uuid(),
    providerPropertyId: z.uuid(),
    threadId: z.string().trim().min(1),
    listingId: z.string().trim().min(1),
    // Digest of the complete provider booking_details reviewed by staff, not a quote.
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ChannexInquiryScope = z.infer<typeof scopeSchema>;
export type ChannexInquiryResult =
  | { ok: true; state: "pending" | "preapproved" | "resolved_other" }
  | {
      ok: false;
      failure:
        | "already_resolved"
        | "provider_rejected"
        | "invalid_request"
        | "provider_read_failed"
        | "provider_scope_mismatch"
        | "inquiry_changed"
        | "decision_outcome_unknown";
    };

const eventSchema = z.object({
  data: z.object({
    id: z.uuid(),
    attributes: z.object({
      id: z.uuid().optional(),
      property_id: z.uuid(),
      event: z.literal("inquiry"),
      payload: z.object({
        message_thread_id: z.string().min(1),
        booking_details: z
          .object({
            property_id: z.uuid(),
            listing_id: z.string().min(1),
            checkin_date: z.iso.date(),
            nights: z.number().int().positive(),
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .passthrough(),
        resolved: z.boolean(),
        status: z.unknown().optional(),
        resolution: z.unknown().optional(),
      }),
    }),
  }),
});

/** Only JSON provider data is accepted; object key order does not affect review identity. */
export function inquiryContextDigest(details: unknown): string {
  function canonical(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    throw new Error("invalid_inquiry_context");
  }
  return createHash("sha256").update(canonical(details)).digest("hex");
}

/** Transport only. Caller owns staff authorization, durable dispatch fencing and audit.
 * No runtime registration; see engineering/native-guest-inbox-contract.md (VAY-383).
 */
export function createChannexInquiryPreapproval(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}) {
  if (
    !/^https:\/\/(app|staging)\.channex\.io(?:\/|\/api\/v1\/?)?$/.test(config.apiBaseUrl) ||
    !config.apiKey.trim()
  )
    throw new Error("invalid_channex_configuration");
  const request = config.fetch ?? fetch;
  function normalize(value: unknown, scope: ChannexInquiryScope): ChannexInquiryResult {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return { ok: false, failure: "provider_read_failed" };
    const { id, attributes } = parsed.data.data;
    const payload = attributes.payload;
    if (
      id !== scope.eventId ||
      (attributes.id && attributes.id !== id) ||
      attributes.property_id !== scope.providerPropertyId ||
      payload.booking_details.property_id !== scope.providerPropertyId ||
      payload.message_thread_id !== scope.threadId ||
      payload.booking_details.listing_id !== scope.listingId
    )
      return { ok: false, failure: "provider_scope_mismatch" };
    if (inquiryContextDigest(payload.booking_details) !== scope.contextDigest)
      return { ok: false, failure: "inquiry_changed" };
    if (!payload.resolved) return { ok: true, state: "pending" };
    const resolution = z
      .object({ type: z.literal("preapproval"), block_instant_booking: z.literal(false) })
      .strict()
      .safeParse(payload.resolution);
    return {
      ok: true,
      state:
        payload.status === "preapproval" && resolution.success ? "preapproved" : "resolved_other",
    };
  }
  async function exchange(scope: ChannexInquiryScope, send = false): Promise<ChannexInquiryResult> {
    try {
      const response = await request(
        new URL(`/api/v1/live_feed/${scope.eventId}${send ? "/resolve" : ""}`, config.apiBaseUrl),
        {
          method: send ? "POST" : "GET",
          headers: {
            "user-api-key": config.apiKey,
            ...(send ? { "content-type": "application/json" } : {}),
          },
          ...(send
            ? {
                body: JSON.stringify({
                  resolution: { type: "preapproval", block_instant_booking: false },
                }),
              }
            : {}),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok)
        return {
          ok: false,
          failure:
            send && [400, 401, 403, 404, 422].includes(response.status)
              ? "provider_rejected"
              : "provider_read_failed",
        };
      return normalize(await response.json(), scope);
    } catch {
      return { ok: false, failure: "provider_read_failed" };
    }
  }
  async function read(scope: ChannexInquiryScope): Promise<ChannexInquiryResult> {
    if (!scopeSchema.safeParse(scope).success) return { ok: false, failure: "invalid_request" };
    return exchange(scope);
  }
  return {
    read,
    // Worker recovery uses read(), never repeats preapprove() after a dispatch marker.
    async preapprove(scope: ChannexInquiryScope): Promise<ChannexInquiryResult> {
      const current = await read(scope);
      if (!current.ok) return current;
      if (current.state !== "pending") return { ok: false, failure: "already_resolved" };
      const sent = await exchange(scope, true);
      if (!sent.ok && sent.failure === "provider_rejected") return sent;
      if (sent.ok && sent.state !== "pending") return sent;
      const reconciled = await read(scope);
      if (reconciled.ok && reconciled.state !== "pending") return reconciled;
      return { ok: false, failure: "decision_outcome_unknown" };
    },
  };
}
