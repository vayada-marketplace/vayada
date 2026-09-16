import {
  parseBookingGuestPolicyChoices,
  type BookingGuestPolicyChoices,
} from "@vayada/domain-booking";
import { targetApiClient } from "./targetClient";
export type GuestRules = { revision: string; choices: BookingGuestPolicyChoices };
type Http = Pick<typeof targetApiClient, "get" | "put">;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const path = (propertyId: string) => {
  if (!uuid(propertyId)) throw new Error("Choose a valid property before editing guest rules.");
  return `/api/booking/properties/${propertyId.toLowerCase()}/guest-rules`;
};
export function createBookingGuestRulesClient(http: Http) {
  return {
    async load(propertyId: string, signal?: AbortSignal): Promise<GuestRules | null> {
      const result = await http.get<unknown>(path(propertyId), { signal, cache: "no-store" });
      if (!record(result) || Object.keys(result).join() !== "current")
        throw new Error("Guest rules could not be loaded.");
      if (result.current === null) return null;
      const current = result.current;
      const choices = record(current) ? parseBookingGuestPolicyChoices(current.choices) : null;
      if (!record(current) || !uuid(current.revision) || !choices)
        throw new Error("Guest rules could not be loaded.");
      return { revision: current.revision, choices };
    },
    async save(
      propertyId: string,
      expectedRevision: string | null,
      choices: BookingGuestPolicyChoices,
      requestId: string,
    ): Promise<GuestRules> {
      const parsed = parseBookingGuestPolicyChoices(choices);
      if (!parsed || !(expectedRevision === null || uuid(expectedRevision)) || !requestId.trim())
        throw new Error("Check your guest rules before saving.");
      const result = await http.put<unknown>(
        path(propertyId),
        { expectedRevision, confirmed: true, choices: parsed },
        { headers: { "Idempotency-Key": requestId } },
      );
      if (!record(result) || !uuid(result.revision) || typeof result.replayed !== "boolean")
        throw new Error("The save could not be confirmed. Retry to check the result.");
      return { revision: result.revision, choices: parsed };
    },
  };
}
export const bookingGuestRulesClient = createBookingGuestRulesClient(targetApiClient);

export function guestRulesErrorMessage(error: unknown): string {
  const code = record(error) && record(error.data) ? error.data.code : null;
  if (code === "guest_choices_stale")
    return "Guest rules changed elsewhere. Reload saved rules before editing again.";
  if (code === "guest_choices_denied")
    return "You no longer have permission to manage these guest rules.";
  if (code === "guest_choices_idempotency_conflict")
    return "This save conflicts with an earlier request. Reload saved rules before trying again.";
  if (code === "invalid_guest_choices")
    return "Check the guest rules and arrival times before saving.";
  return error instanceof Error ? error.message : "Guest rules are unavailable. Please retry.";
}
