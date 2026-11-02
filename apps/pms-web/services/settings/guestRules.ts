import {
  parseBookingGuestPolicyChoices,
  type BookingGuestPolicyChoices,
} from "@vayada/domain-booking";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";

/** The guest rules the live booking page shows guests: check-in and check-out times, children and the booking
 * form (VAY-2455). The hotel's first run and Booking Admin's setup save them; the API lets only members holding
 * `booking.settings.manage` on a Booking Engine property read them. */
export type GuestRules = { revision: string; choices: BookingGuestPolicyChoices };

const endpoint = (id: string) => `/api/booking/properties/${encodeURIComponent(id)}/guest-rules`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const guestRulesService = {
  /** The selected property's (or `propertyId`'s) guest rules; null while it has none. */
  async load(signal?: AbortSignal, propertyId?: string): Promise<GuestRules | null> {
    const id = propertyId ?? (await resolveSelectedPmsPropertyId("loading guest rules"));
    const result = await pmsOperationsClient.get<unknown>(endpoint(id), {
      ...pmsOperationsRequestOptions,
      signal,
    });
    if (!record(result) || !("current" in result))
      throw new Error("Guest rules could not be loaded.");
    if (result.current === null) return null;
    const current = result.current;
    const choices = record(current) ? parseBookingGuestPolicyChoices(current.choices) : null;
    if (!record(current) || typeof current.revision !== "string" || !choices)
      throw new Error("Guest rules could not be loaded.");
    return { revision: current.revision, choices };
  },
  /** Saves `choices` over `expectedRevision` (null for a property's first rules); the API republishes a live booking
   * page with them. A save changed elsewhere since loading is refused (`guest_choices_stale`). */
  async save(
    propertyId: string,
    expectedRevision: string | null,
    choices: BookingGuestPolicyChoices,
    idempotencyKey: string,
  ): Promise<string> {
    const result = await pmsOperationsClient.put<unknown>(
      endpoint(propertyId),
      { expectedRevision, confirmed: true, choices },
      {
        ...pmsOperationsRequestOptions,
        headers: { ...pmsOperationsRequestOptions.headers, "Idempotency-Key": idempotencyKey },
      },
    );
    if (!record(result) || typeof result.revision !== "string")
      throw new Error("The save could not be confirmed. Reload saved values to check it.");
    return result.revision;
  },
};

const SAVE_ERRORS: Record<string, string> = {
  guest_choices_stale:
    "Another user changed these settings. Reload saved values before saving again.",
  guest_choices_idempotency_conflict:
    "This save conflicts with an earlier one. Reload saved values before saving again.",
  guest_choices_denied: "You no longer have permission to change these settings.",
  invalid_guest_choices: "Check the guest policies and times before saving.",
};

/** What to tell the user about a refused save: the API answers its refusals with a `code`. */
export function guestRulesSaveError(error: unknown): string {
  const data = record(error) && record(error.data) ? error.data : null;
  const code = typeof data?.code === "string" ? data.code : "";
  return SAVE_ERRORS[code] ?? "Arrival times could not be saved. Please try again.";
}
