import type { BookingGuestPolicySetupAggregate } from "@vayada/domain-booking";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";

const endpoint = (id: string) =>
  `/api/booking/properties/${encodeURIComponent(id)}/booking-guest-policy`;
/** The PMS guest policy Settings saved before VAY-2455, which the live booking page doesn't show: read only to
 * prefill a property's first guest rules (guestRules.ts). */
export const arrivalTimesService = {
  async load(signal?: AbortSignal): Promise<BookingGuestPolicySetupAggregate> {
    const id = await resolveSelectedPmsPropertyId("loading arrival times");
    return pmsOperationsClient.get(endpoint(id), { ...pmsOperationsRequestOptions, signal });
  },
};
