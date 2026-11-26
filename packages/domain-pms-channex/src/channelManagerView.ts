/**
 * VAY-2606: what the PMS Channel manager page shows, read-only. Account admins and staff whose role has
 * `pms.channel_manager.read` read it for the hotels they work for. Nothing in it changes what Booking.com or
 * Airbnb sell; markups and mappings are shown as they are, never edited here.
 */
export const CHANNEL_MANAGER_VIEW_CONTRACT_VERSION = "pms-channel-manager-view.v1" as const;

export type ChannelManagerOta = "booking_com" | "airbnb";

/** One rule of a Channex price modifier, applied in order ("increase_by_percent", "12"). */
export type ChannelManagerMarkupRule = Readonly<{
  operation:
    | "increase_by_percent"
    | "decrease_by_percent"
    | "increase_by_amount"
    | "decrease_by_amount";
  value: string;
}>;

/**
 * The markup a channel adds, as set in Channex. `rules` is empty when nothing is added. `varies` when the mapped
 * rooms or listings don't all have the same rules; `unknown` when Channex holds a rule this page can't read.
 */
export type ChannelManagerMarkup =
  | Readonly<{ kind: "rules"; rules: readonly ChannelManagerMarkupRule[]; currency: string | null }>
  | Readonly<{ kind: "varies" }>
  | Readonly<{ kind: "unknown" }>;

export type ChannelManagerChannel = Readonly<{
  ota: ChannelManagerOta;
  active: boolean;
  /** Booking.com's hotel id; null for Airbnb. */
  otaPropertyId: string | null;
  /** Mapped Booking.com rooms, or mapped Airbnb listings. */
  mappedCount: number;
  markup: ChannelManagerMarkup;
}>;

/**
 * `unavailable` when Channex couldn't be read just now (or isn't set up in this environment); the rest of the
 * page still shows.
 */
export type ChannelManagerChannels =
  | Readonly<{ status: "ok"; items: readonly ChannelManagerChannel[] }>
  | Readonly<{ status: "unavailable" }>;

/** One room and plan as Booking.com and Airbnb sell it: a published offer on the current Channex connection. */
export type ChannelManagerRoom = Readonly<{
  targetId: string;
  roomTypeId: string;
  roomTypeName: string;
  /** The offer's meal plan as sent to Channex ("room_only", "breakfast", …). */
  mealPlan: string | null;
  /** The most guests the offer is sold for. */
  maxGuests: number | null;
  selling: boolean;
  /** Why a room isn't selling: sales aren't switched on, or the calendar has no open night in the next 12 months. */
  notSellingReason: "sales_closed" | "no_open_nights" | null;
}>;

export type ChannelManagerSync = Readonly<{
  /**
   * Prices and availability going out to Channex. `partial`: the last run went out but left some rooms'
   * offers behind (VAY-2108 D3), until a run delivers them all.
   */
  prices: Readonly<{
    status: "ok" | "partial" | "retrying" | "failed" | "never";
    lastSuccessAt: string | null;
    retryAt: string | null;
  }>;
  /**
   * New bookings coming in from Channex. The pull runs every five minutes: `retrying` after a failed run,
   * `failed` when no run has succeeded for half an hour.
   */
  bookings: Readonly<{
    status: "ok" | "retrying" | "failed" | "never";
    lastCheckedAt: string | null;
    /** The newest booking Channex delivered: no guest details. */
    latest: Readonly<{
      channel: string;
      roomTypeName: string | null;
      checkIn: string;
      checkOut: string;
    }> | null;
  }>;
}>;

/** An open problem, from the Channex alerts, with the facts the page words it from. No guest details. */
export type ChannelManagerProblem = Readonly<{
  id: string;
  eventType: string;
  /** The OTA as Channex names it ("BookingCom", "Airbnb"), when known. */
  channel: string | null;
  roomTypeName: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  /** The OTA's own reservation code, the one the hotel finds in its extranet. */
  reference: string | null;
  errorType: string | null;
  firstOccurredAt: string;
  acknowledgedAt: string | null;
}>;

export type ChannelManagerView = Readonly<{
  contractVersion: typeof CHANNEL_MANAGER_VIEW_CONTRACT_VERSION;
  propertyId: string;
  connection: Readonly<{
    status: "connected" | "disconnected" | "suspended" | "degraded" | "setup_incomplete";
  }>;
  channels: ChannelManagerChannels;
  rooms: readonly ChannelManagerRoom[];
  sync: ChannelManagerSync;
  problems: readonly ChannelManagerProblem[];
}>;
