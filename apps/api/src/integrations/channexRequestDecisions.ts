import { z } from "zod";

const scopeSchema = z.object({
  eventId: z.uuid(),
  providerPropertyId: z.uuid(),
  kind: z.enum(["reservation_request", "alteration_request"]),
});
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }).strict(),
  z
    .object({
      action: z.literal("decline"),
      reason: z
        .enum([
          "dates_not_available",
          "not_a_good_fit",
          "waiting_for_better_reservation",
          "not_comfortable",
        ])
        .optional(),
    })
    .strict(),
]);
export type ChannexRequestScope = z.infer<typeof scopeSchema>;
export type ChannexRequestDecision = z.infer<typeof decisionSchema>;
export type ChannexRequestState =
  | "pending"
  | "accepted"
  | "declined"
  | "withdrawn"
  | "resolved_unknown";
export type ChannexRequestResult =
  | { ok: true; state: ChannexRequestState }
  | {
      ok: false;
      failure:
        | "invalid_request"
        | "provider_read_failed"
        | "provider_scope_mismatch"
        | "decision_outcome_unknown";
    };

const eventSchema = z.object({
  data: z.object({
    id: z.uuid(),
    attributes: z.object({
      id: z.uuid().optional(),
      property_id: z.uuid(),
      event: z.string(),
      payload: z.object({
        resolved: z.boolean(),
        resolution: z.unknown().optional(),
        status: z.unknown().optional(),
      }),
    }),
  }),
});

/** Transport only: callers must authorize, serialize and durably audit decisions.
 * See engineering/airbnb-request-decisions.md. Not registered with any runtime.
 */
export function createChannexRequestDecisions(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}) {
  if (
    !/^https:\/\/(app|staging)\.channex\.io(?:\/|\/api\/v1\/?)?$/.test(config.apiBaseUrl) ||
    !config.apiKey.trim()
  ) {
    throw new Error("invalid_channex_configuration");
  }
  const base = new URL(config.apiBaseUrl);
  const request = config.fetch ?? fetch;
  function normalize(value: unknown, scope: ChannexRequestScope): ChannexRequestResult {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return { ok: false, failure: "provider_read_failed" };
    const { id, attributes } = parsed.data.data;
    if (
      id !== scope.eventId ||
      (attributes.id && attributes.id !== id) ||
      attributes.property_id !== scope.providerPropertyId ||
      attributes.event !== scope.kind
    ) {
      return { ok: false, failure: "provider_scope_mismatch" };
    }
    const { resolved, resolution, status } = attributes.payload;
    if (!resolved) return { ok: true, state: "pending" };
    const outcome = scope.kind === "reservation_request" ? resolution : status;
    const state =
      outcome === "accepted" || outcome === "ACCEPTED"
        ? "accepted"
        : outcome === "declined" || outcome === "DECLINED"
          ? "declined"
          : outcome === "CANCELED" || outcome === "cancelled"
            ? "withdrawn"
            : "resolved_unknown";
    return { ok: true, state };
  }
  async function exchange(
    scope: ChannexRequestScope,
    body?: unknown,
  ): Promise<ChannexRequestResult> {
    try {
      const response = await request(
        new URL(`/api/v1/live_feed/${scope.eventId}${body ? "/resolve" : ""}`, base),
        {
          method: body ? "POST" : "GET",
          headers: {
            "user-api-key": config.apiKey,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) return { ok: false, failure: "provider_read_failed" };
      return normalize(await response.json(), scope);
    } catch {
      // Never expose provider response bodies, request URLs or credentials.
      return { ok: false, failure: "provider_read_failed" };
    }
  }
  async function read(scope: ChannexRequestScope): Promise<ChannexRequestResult> {
    if (!scopeSchema.safeParse(scope).success) return { ok: false, failure: "invalid_request" };
    return exchange(scope);
  }
  return {
    read,
    async resolve(
      scope: ChannexRequestScope,
      decision: ChannexRequestDecision,
    ): Promise<ChannexRequestResult> {
      const parsed = decisionSchema.safeParse(decision);
      if (
        !scopeSchema.safeParse(scope).success ||
        !parsed.success ||
        (scope.kind === "alteration_request" && "reason" in parsed.data)
      ) {
        return { ok: false, failure: "invalid_request" };
      }
      const current = await read(scope);
      if (!current.ok || current.state !== "pending") return current;
      const resolution =
        scope.kind === "alteration_request"
          ? { accept: parsed.data.action }
          : parsed.data.action === "accept"
            ? { accept: true }
            : { accept: false, reason: parsed.data.reason ?? "not_comfortable" };
      const sent = await exchange(scope, { resolution });
      if (sent.ok && sent.state !== "pending") return sent;
      const reconciled = await read(scope);
      if (reconciled.ok && reconciled.state !== "pending") return reconciled;
      return { ok: false, failure: "decision_outcome_unknown" };
    },
  };
}
