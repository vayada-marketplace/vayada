import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";

/** The check-in and check-out times guests see on the booking page ("15:00", "11:00"): the property's guest rules,
 * read only. Members holding `pms.reservation.read` (the front desk too) may read them (VAY-2455). */
export type GuestStayTimes = { checkInTime: string; checkOutTime: string };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const localTime = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export const guestStayTimesService = {
  /** The selected property's times; null while it has no guest rules. */
  async load(): Promise<GuestStayTimes | null> {
    const id = await resolveSelectedPmsPropertyId("loading check-in and check-out times");
    const result = await pmsOperationsClient.get<unknown>(
      `/api/pms/properties/${encodeURIComponent(id)}/guest-stay-times`,
      pmsOperationsRequestOptions,
    );
    if (!record(result) || !("times" in result))
      throw new Error("Check-in and check-out times could not be loaded.");
    if (result.times === null) return null;
    const times = result.times;
    if (!record(times) || !localTime(times.checkInTime) || !localTime(times.checkOutTime))
      throw new Error("Check-in and check-out times could not be loaded.");
    return { checkInTime: times.checkInTime, checkOutTime: times.checkOutTime };
  },
};
