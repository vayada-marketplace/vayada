import { z } from "zod";
const binding = z.object({
  eventId: z.uuid(),
  connectionId: z.uuid(),
  bindingGeneration: z.uuid(),
  providerPropertyId: z.uuid(),
});
/** Staff-safe projection. Never expose provider identifiers or the decision journal. */
export function presentChannexAlteration(
  changes: Record<string, unknown>,
  enabled = false,
  status = "pending",
) {
  if (!Object.prototype.hasOwnProperty.call(changes, "channex")) return undefined;
  const provider = object(changes["channex"]),
    decision = object(provider["decision"]);
  const action =
    decision["action"] === "accept" || decision["action"] === "decline" ? decision["action"] : null;
  const observed = provider["providerState"];
  const outcome = observed && observed !== "pending" ? observed : decision["providerState"];
  const state = !binding.safeParse(provider).success
    ? "unavailable"
    : status === "accepted"
      ? "applied"
      : status === "declined"
        ? "declined"
        : status === "canceled"
          ? "withdrawn"
          : provider["appliedRevisionId"]
            ? "applied"
            : outcome === "accepted"
              ? "awaiting_confirmation"
              : outcome === "declined"
                ? "declined"
                : outcome === "withdrawn"
                  ? "withdrawn"
                  : outcome === "resolved_unknown"
                    ? "unavailable"
                    : decision["sendStartedAt"]
                      ? "unknown"
                      : action
                        ? "queued"
                        : "pending";
  const actionable = enabled && (state === "pending" || state === "queued");
  return {
    provider: "airbnb" as const,
    state,
    allowedActions: actionable ? (action ? [action] : ["accept", "decline"]) : [],
    refreshAction: enabled && state === "unknown" ? action : null,
    oldTotal: amount(changes["oldTotal"]),
    newTotal: amount(changes["newTotal"]),
    priceDifference: amount(changes["priceDifference"]),
    currency:
      typeof changes["currency"] === "string" && /^[A-Z]{3}$/.test(changes["currency"])
        ? changes["currency"]
        : null,
    oldAdults: count(changes["oldAdults"]),
    oldChildren: count(changes["oldChildren"]),
    requestedAdults: count(changes["requestedAdults"]),
    requestedChildren: count(changes["requestedChildren"]),
  };
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function amount(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && /^-?\d+(?:\.\d{1,2})?$/.test(value))
  )
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
