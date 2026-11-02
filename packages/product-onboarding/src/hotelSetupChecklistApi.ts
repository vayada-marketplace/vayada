import {
  parseHotelGoLiveChecklist,
  parseHotelSetupChecklist,
  type HotelGoLiveChecklist,
  type HotelSetupChecklist,
  type HotelSetupChecklistAcknowledgeable,
} from "@vayada/domain-hotels";

type Http = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
  put<T>(path: string, value?: unknown, options?: RequestInit): Promise<T>;
};

const path = (propertyId: string, suffix = "") =>
  `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/checklist${suffix}`;

function checklist(value: unknown, propertyId: string): HotelSetupChecklist {
  const parsed = parseHotelSetupChecklist(value);
  if (!parsed || parsed.propertyId !== propertyId.toLowerCase())
    throw new Error(
      "The setup checklist is invalid or belongs to another hotel. Refresh and try again.",
    );
  return parsed;
}

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
 * VAY-2247 wave 2: the setup checklist API (apps/api routes/hotelSetupChecklist.ts) for both dashboards.
 * The API is mounted only with the server's first run (HOTEL_FIRST_RUN_ENABLED); until then every call
 * fails (404) and the dashboards keep what they show today.
 */
export function createHotelSetupChecklistClient(http: Http) {
  return {
    async load(propertyId: string, options?: RequestInit): Promise<HotelSetupChecklist> {
      return checklist(
        await http.get<unknown>(path(propertyId), { ...options, cache: "no-store" }),
        propertyId,
      );
    },
    /** "Looks good" on calendar or guest terms, for the whole hotel. */
    async looksGood(
      propertyId: string,
      item: HotelSetupChecklistAcknowledgeable,
    ): Promise<HotelSetupChecklist> {
      return checklist(
        await http.post<unknown>(path(propertyId, "/acknowledgements"), { item }),
        propertyId,
      );
    },
    /** The signed-in person's own Hide for now (or showing it again) and Dismiss. */
    async setViewer(
      propertyId: string,
      change: Readonly<{ hidden?: boolean; dismissed?: boolean }>,
    ): Promise<HotelSetupChecklist> {
      return checklist(await http.put<unknown>(path(propertyId, "/viewer"), change), propertyId);
    },
    /**
     * VAY-2451: the four-step setup's go-live list, or null when the API answers 404 (it is mounted only
     * with HOTEL_GO_LIVE_CHECKLIST_ENABLED), in which case the dashboard keeps today's checklist.
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
