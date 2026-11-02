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
  /** The selected property's guest rules; null while it has none. */
  async load(signal?: AbortSignal): Promise<GuestRules | null> {
    const id = await resolveSelectedPmsPropertyId("loading guest rules");
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
};
