import { apiClient, type ApiClient } from "./client";

/** GET /api/booking/properties/:id/notifications (VAY-2349): the bell's feed for the selected property, the
 * last 30 days, newest first; plus the person's read marks. */
export type HostNotificationKind =
  | "booking_new"
  | "booking_modified"
  | "booking_cancelled"
  | "payment_not_received"
  | "promo_ending"
  | "promo_limit_reached"
  | "team_member_joined";

export type HostNotificationCategory = "bookings" | "needs_action" | "updates";

export type HostNotificationBooking = {
  id: string;
  reference: string;
  guestName: string;
  guestEmail: string | null;
  roomName: string;
  roomCount: number;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  totalAmount: string | null;
  currency: string;
  paymentStatus: string;
  awaiting: "payment" | "acceptance" | null;
  cancelledBy: "guest" | "hotel" | "system" | null;
  cancelReason: "request_expired" | "payment_not_completed" | null;
  change: {
    kind: "dates";
    previousTotal: string | null;
    newTotal: string | null;
  } | null;
};

export type HostNotification = {
  key: string;
  kind: HostNotificationKind;
  category: HostNotificationCategory;
  occurredAt: string;
  read: boolean;
  booking?: HostNotificationBooking;
  promo?: { id: string; code: string; validUntil: string | null; uses: number; maxUses: number };
  /** The new member's name, or null when their account has none. */
  member?: { name: string | null; role: string };
};

export type HostNotificationSyncAlert = {
  key: string;
  read: boolean;
  domains: ("ari" | "booking")[];
  failedAt: string;
  lastSuccessAt: string | null;
  canRetry: boolean;
  /** Whether the person may open PMS → Channel manager ("View details"). */
  canViewDetails: boolean;
};

export type HostNotificationFeed = {
  /** When the API read the feed; "Mark all read" sends it back. */
  generatedAt: string;
  timeZone: string;
  items: HostNotification[];
  syncAlert: HostNotificationSyncAlert | null;
  unread: { all: number; bookings: number; needsAction: number; updates: number };
  badge: "none" | "blue" | "red";
};

type Http = Pick<ApiClient, "get" | "post">;

const KINDS = new Set<string>([
  "booking_new",
  "booking_modified",
  "booking_cancelled",
  "payment_not_received",
  "promo_ending",
  "promo_limit_reached",
  "team_member_joined",
]);
const CATEGORIES = new Set<string>(["bookings", "needs_action", "updates"]);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Whether the bell can read a property's notifications: Booking Admin's selected id must be the
 * property's UUID. */
export function isNotificationPropertyId(propertyId: string | undefined): propertyId is string {
  return uuid(propertyId);
}

/** A time zone this browser knows, else UTC: Intl throws on one it doesn't. */
function knownTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

function path(propertyId: string, suffix = ""): string {
  if (!uuid(propertyId)) throw new Error("Choose a property before opening notifications.");
  return `/api/booking/properties/${propertyId.toLowerCase()}/notifications${suffix}`;
}

function item(v: unknown): v is HostNotification {
  return (
    record(v) &&
    typeof v.key === "string" &&
    KINDS.has(v.kind as string) &&
    CATEGORIES.has(v.category as string) &&
    typeof v.occurredAt === "string" &&
    !Number.isNaN(Date.parse(v.occurredAt)) &&
    typeof v.read === "boolean" &&
    (v.booking === undefined ||
      (record(v.booking) &&
        typeof v.booking.reference === "string" &&
        day(v.booking.checkIn) &&
        day(v.booking.checkOut) &&
        typeof v.booking.currency === "string" &&
        /^[A-Z]{3}$/.test(v.booking.currency))) &&
    (v.promo === undefined ||
      (record(v.promo) &&
        typeof v.promo.code === "string" &&
        (v.promo.validUntil === null || day(v.promo.validUntil)))) &&
    (v.member === undefined ||
      (record(v.member) && (v.member.name === null || typeof v.member.name === "string")))
  );
}

export function parseHostNotificationFeed(v: unknown): HostNotificationFeed | null {
  if (
    !record(v) ||
    typeof v.generatedAt !== "string" ||
    typeof v.timeZone !== "string" ||
    !Array.isArray(v.items)
  )
    return null;
  const unread = v.unread;
  if (
    !record(unread) ||
    !count(unread.all) ||
    !count(unread.bookings) ||
    !count(unread.needsAction) ||
    !count(unread.updates) ||
    !["none", "blue", "red"].includes(v.badge as string)
  )
    return null;
  const alert = v.syncAlert;
  if (
    alert !== null &&
    !(
      record(alert) &&
      typeof alert.key === "string" &&
      typeof alert.read === "boolean" &&
      Array.isArray(alert.domains) &&
      typeof alert.failedAt === "string" &&
      (alert.lastSuccessAt === null || typeof alert.lastSuccessAt === "string") &&
      typeof alert.canRetry === "boolean"
    )
  )
    return null;
  // A kind this version doesn't know (from a newer API), or a row it can't show, is skipped.
  const items = v.items.filter(item);
  return {
    ...(v as HostNotificationFeed),
    timeZone: knownTimeZone(v.timeZone),
    items,
    syncAlert: alert
      ? { ...(alert as HostNotificationSyncAlert), canViewDetails: alert.canViewDetails === true }
      : null,
  };
}

export function createBookingNotificationsClient(http: Http) {
  return {
    async load(propertyId: string, signal?: AbortSignal): Promise<HostNotificationFeed> {
      const feed = parseHostNotificationFeed(
        await http.get<unknown>(path(propertyId), { signal, cache: "no-store" }),
      );
      if (!feed) throw new Error("Notifications could not be loaded.");
      return feed;
    },
    // keepalive: a mark made right before a page change still reaches the API.
    async markRead(propertyId: string, keys: string[]): Promise<void> {
      await http.post(path(propertyId, "/read"), { keys }, { keepalive: true });
    },
    /** Marks what the person saw: items up to the feed's generatedAt, and the sync card it showed. */
    async markAllRead(
      propertyId: string,
      seen: { before: string; syncAlertKey: string | null },
    ): Promise<void> {
      await http.post(path(propertyId, "/read-all"), seen, { keepalive: true });
    },
    /** "Retry sync": the same command as PMS → Channel manager → Sync now, once per failing sync.
     * Returns the operations to follow. */
    async retrySync(propertyId: string, domains: ("ari" | "booking")[]): Promise<string[]> {
      if (!uuid(propertyId)) throw new Error("Choose a property before retrying the sync.");
      const operations: string[] = [];
      for (const domain of domains) {
        const id = crypto.randomUUID();
        const operation = await http.post<unknown>(
          `/api/pms/properties/${propertyId.toLowerCase()}/channex/commands`,
          {
            commandId: id,
            idempotencyKey: id,
            operationType: domain === "ari" ? "sync_ari" : "sync_bookings",
          },
        );
        if (!record(operation) || typeof operation.operationId !== "string")
          throw new Error("The sync could not be started.");
        operations.push(operation.operationId);
      }
      return operations;
    },
    /** Where a sync operation stands: done, failed, or still running. */
    async syncOperationStatus(
      propertyId: string,
      operationId: string,
    ): Promise<"succeeded" | "failed" | "running"> {
      if (!uuid(propertyId)) throw new Error("Choose a property before checking the sync.");
      const operation = await http.get<unknown>(
        `/api/pms/properties/${propertyId.toLowerCase()}/channex/operations/${encodeURIComponent(operationId)}`,
        { cache: "no-store" },
      );
      const status = record(operation) ? operation.status : null;
      if (status === "succeeded") return "succeeded";
      if (status === "failed" || status === "dead_lettered") return "failed";
      return "running";
    },
  };
}

export const bookingNotificationsClient = createBookingNotificationsClient(apiClient);
