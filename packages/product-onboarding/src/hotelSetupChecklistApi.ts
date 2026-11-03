import {
  parseHotelGoLiveChecklist,
  type HotelGoLiveChecklist,
  type HotelSetupChecklistAcknowledgeable,
} from "@vayada/domain-hotels";

type Http = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
  put<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
};

const path = (propertyId: string, suffix = "") =>
  `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/checklist${suffix}`;

function goLive(value: unknown, propertyId: string): HotelGoLiveChecklist {
  const parsed = parseHotelGoLiveChecklist(value);
  if (!parsed || parsed.propertyId !== propertyId.toLowerCase())
    throw new Error(
      "The go-live checklist is invalid or belongs to another hotel. Refresh and try again.",
    );
  return parsed;
}

const notFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  (error as { status: unknown }).status === 404;

/**
 * VAY-2247 wave 2, VAY-2451: the go-live checklist API (apps/api routes/hotelSetupChecklist.ts,
 * /checklist/v2) for both dashboards. The API is mounted only with the server's first run
 * (HOTEL_FIRST_RUN_ENABLED); until then every call fails (404) and the dashboards keep what they show today.
 */
export function createHotelSetupChecklistClient(http: Http) {
  return {
    /**
     * VAY-2451: the four-step setup's go-live list, or null when the API answers 404 (it isn't mounted, or the
     * hotel isn't there), in which case the dashboards keep what they show today.
     */
    async loadGoLive(
      propertyId: string,
      options?: RequestInit,
    ): Promise<HotelGoLiveChecklist | null> {
      try {
        return goLive(
          await http.get<unknown>(path(propertyId, "/v2"), { ...options, cache: "no-store" }),
          propertyId,
        );
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    /** "Review booking rules": the guest terms' "Looks good", answered with the go-live list. */
    async looksGoodGoLive(
      propertyId: string,
      item: HotelSetupChecklistAcknowledgeable,
    ): Promise<HotelGoLiveChecklist> {
      return goLive(
        await http.post<unknown>(path(propertyId, "/v2/acknowledgements"), { item }),
        propertyId,
      );
    },
    async setGoLiveViewer(
      propertyId: string,
      change: Readonly<{ hidden?: boolean; dismissed?: boolean }>,
    ): Promise<HotelGoLiveChecklist> {
      return goLive(await http.put<unknown>(path(propertyId, "/v2/viewer"), change), propertyId);
    },
  };
}

export type HotelSetupChecklistClient = ReturnType<typeof createHotelSetupChecklistClient>;
