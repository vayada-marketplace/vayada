import type pg from "pg";
import type { QueryResultRow } from "pg";

import {
  BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL,
  propertyCanAccessGuestContact,
} from "./bookingGuestContactAccess.js";
import { readPropertyPlan } from "./propertyPlanReadModel.js";

/** Booking Admin's notifications bell (VAY-2349): the selected property's last 30 days, built on each read
 * from the rows that already record what happened. Only read marks are stored (migration 0514). */
export const HOST_NOTIFICATION_WINDOW_DAYS = 30;
export const HOST_NOTIFICATION_READ_RETENTION_DAYS = 60;
/** Rows per tab category; the unread counts cover all 30 days. */
export const HOST_NOTIFICATION_LIST_LIMIT = 50;
export const HOST_NOTIFICATION_MARK_LIMIT = 100;
/** A failing sync shows once its retries ran out, or once its retry is this late. */
export const HOST_NOTIFICATION_SYNC_GRACE_MINUTES = 15;
/** Promo codes ending within this many days (property calendar) show as "expires soon". */
export const HOST_NOTIFICATION_PROMO_ENDING_DAYS = 7;

const KEY_PATTERN = /^[a-z][a-z-]*:[A-Za-z0-9:._-]{1,200}$/;

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
  /** Only on "payment not received", and only when the person may see the guest's contact. */
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
  /** What a booking still waits for now: the guest's payment or the hotel's answer. */
  awaiting: "payment" | "acceptance" | null;
  cancelledBy: "guest" | "hotel" | "system" | null;
  cancelReason: "request_expired" | "payment_not_completed" | null;
  change: {
    kind: "dates";
    previousTotal: string | null;
    newTotal: string | null;
  } | null;
};

export type HostNotificationPromo = {
  id: string;
  code: string;
  validUntil: string | null;
  uses: number;
  maxUses: number;
};

export type HostNotification = {
  key: string;
  kind: HostNotificationKind;
  category: HostNotificationCategory;
  occurredAt: string;
  read: boolean;
  booking?: HostNotificationBooking;
  promo?: HostNotificationPromo;
  /** The new member's name, or null when their account has none. */
  member?: { name: string | null; role: string };
};

export type HostSyncDomain = "ari" | "booking";

/** The pinned "Channel manager sync failed" card: shown until the next successful sync. */
export type HostNotificationSyncAlert = {
  key: string;
  read: boolean;
  domains: HostSyncDomain[];
  failedAt: string;
  lastSuccessAt: string | null;
  canRetry: boolean;
  /** Whether the person may open PMS → Channel manager ("View details"). */
  canViewDetails: boolean;
};

export type HostNotificationUnread = {
  all: number;
  bookings: number;
  needsAction: number;
  updates: number;
};

export type HostNotificationFeed = {
  /** When the feed was read; "Mark all read" sends it back so later items stay unread. */
  generatedAt: string;
  timeZone: string;
  items: HostNotification[];
  syncAlert: HostNotificationSyncAlert | null;
  unread: HostNotificationUnread;
  /** Red while the channel sync is failing (read or not) or a missed payment is unread, blue for other
   * unread, none otherwise. */
  badge: "none" | "blue" | "red";
};

export type HostNotificationViewer = {
  userId: string;
  organizationId: string;
  canReadPromos: boolean;
  canReadGuestContact: boolean;
  /** The syncs this person can rerun from the bell: they may, and that sync command is switched on. */
  retrySyncDomains: readonly HostSyncDomain[];
  /** Whether the person may open PMS → Channel manager. */
  canOpenChannelManager: boolean;
};

/** "Mark all read" as the person saw it: items up to `before`, and the sync card they were shown. */
export type HostNotificationReadAll = { before: Date; syncAlertKey: string | null };

export type BookingHostNotificationsRepository = {
  /** Null when the property doesn't exist. */
  read(propertyId: string, viewer: HostNotificationViewer): Promise<HostNotificationFeed | null>;
  markRead(propertyId: string, userId: string, keys: readonly string[]): Promise<void>;
  markAllRead(
    propertyId: string,
    viewer: HostNotificationViewer,
    seen: HostNotificationReadAll,
  ): Promise<void>;
  close?(): Promise<void>;
};

export function isHostNotificationKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

// ---------------------------------------------------------------- sources

export type BookingEventRow = {
  eventId: string;
  eventType: string;
  actorType: string;
  occurredAt: Date;
  payload: unknown;
  bookingId: string;
  reference: string;
  lifecycleStatus: string;
  paymentStatus: string;
  cancellationReason: string | null;
  paymentMethod: string | null;
  hadHostDeadline: boolean;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  roomCount: number;
  totalAmount: string | null;
  currency: string;
  firstName: string;
  lastName: string;
  email: string | null;
  contactAccepted: boolean;
  roomName: string;
};

export type SyncStatusRow = {
  connectionId: string;
  domain: HostSyncDomain;
  lastAttemptAt: Date;
  lastSuccessAt: Date | null;
};

export type PromoRow = {
  id: string;
  code: string;
  validUntil: string | null;
  uses: number;
  maxUses: number;
  endingSince: Date | null;
  limitReachedAt: Date | null;
};

export type MemberRow = {
  membershipId: string;
  joinedAt: Date;
  name: string | null;
  role: string;
};

export type HostNotificationSources = {
  timeZone: string;
  bookingEvents: BookingEventRow[];
  syncStatuses: SyncStatusRow[];
  promos: PromoRow[];
  members: MemberRow[];
  readKeys: ReadonlySet<string>;
  /** Whether the property's plan lets hosts see guest contact before acceptance. */
  guestContactAlways: boolean;
};

const MISSED_PAYMENT_REASONS = new Set(["accepted_payment_expired", "stale_unpaid_booking"]);

function missedBankTransfer(row: BookingEventRow): boolean {
  if (row.actorType !== "system" || row.paymentMethod !== "bank_transfer") return false;
  if (row.cancellationReason && MISSED_PAYMENT_REASONS.has(row.cancellationReason)) return true;
  // A request the hotel never answered expires with the same reason; only a missed payment counts here.
  return row.cancellationReason === "pending_booking_expired" && !row.hadHostDeadline;
}

function cancelledBy(actorType: string): HostNotificationBooking["cancelledBy"] {
  if (actorType === "guest") return "guest";
  if (actorType === "property_user") return "hotel";
  return "system";
}

function amountText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  return null;
}

type Classified = Pick<HostNotification, "kind" | "category"> & Partial<HostNotificationBooking>;

/** What a status event means for the hotel, or null when the bell leaves it out.
 * A card booking only counts once the card is authorised (a request) or paid (instant booking): before
 * that it is a checkout in progress, and one that never paid expires unseen. */
function classifyBookingEvent(row: BookingEventRow): Classified | null {
  const card = row.paymentMethod === "card";
  switch (row.eventType) {
    case "guest_booking.created":
      return card ? null : { kind: "booking_new", category: "bookings" };
    case "guest_booking.payment_authorized":
      return card ? { kind: "booking_new", category: "bookings" } : null;
    case "guest_booking.payment_received":
      return card && row.actorType === "system"
        ? { kind: "booking_new", category: "bookings" }
        : null;
    case "guest_booking.host_dates_updated":
    case "guest_booking.change_accepted": {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        kind: "booking_modified",
        category: "bookings",
        change: {
          kind: "dates",
          previousTotal: amountText(payload["oldTotal"]),
          newTotal: amountText(payload["newTotal"]),
        },
      };
    }
    case "guest_booking.canceled":
    case "guest_booking.expired": {
      if (missedBankTransfer(row))
        return { kind: "payment_not_received", category: "needs_action" };
      const expired = row.cancellationReason === "pending_booking_expired";
      // A card checkout that was never paid: it never showed as a booking.
      if (card && expired && !row.hadHostDeadline) return null;
      return {
        kind: "booking_cancelled",
        category: "bookings",
        cancelledBy: cancelledBy(row.actorType),
        cancelReason: expired
          ? row.hadHostDeadline
            ? "request_expired"
            : "payment_not_completed"
          : null,
      };
    }
    case "guest_booking.withdrawn":
      return { kind: "booking_cancelled", category: "bookings", cancelledBy: "guest" };
    case "guest_booking.declined":
    case "guest_booking.rejected":
      return { kind: "booking_cancelled", category: "bookings", cancelledBy: "hotel" };
    default:
      return null;
  }
}

/** The status events the bell reads; classifyBookingEvent decides which of them it lists. */
export const HOST_NOTIFICATION_BOOKING_EVENTS = [
  "guest_booking.created",
  "guest_booking.payment_authorized",
  "guest_booking.payment_received",
  "guest_booking.host_dates_updated",
  "guest_booking.change_accepted",
  "guest_booking.canceled",
  "guest_booking.expired",
  "guest_booking.withdrawn",
  "guest_booking.declined",
  "guest_booking.rejected",
] as const;

function bookingNotifications(
  sources: HostNotificationSources,
  viewer: HostNotificationViewer,
): HostNotification[] {
  const out: HostNotification[] = [];
  const newBookings = new Set<string>();
  // Oldest first, so a card booking is new once: at its first authorisation or payment.
  for (const row of [...sources.bookingEvents].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  )) {
    const classified = classifyBookingEvent(row);
    if (!classified) continue;
    const { kind, category, ...details } = classified;
    if (kind === "booking_new") {
      if (newBookings.has(row.bookingId)) continue;
      newBookings.add(row.bookingId);
    }
    const contactAllowed =
      viewer.canReadGuestContact && (sources.guestContactAlways || row.contactAccepted);
    const key = `booking-event:${row.eventId}`;
    out.push({
      key,
      kind,
      category,
      occurredAt: row.occurredAt.toISOString(),
      read: sources.readKeys.has(key),
      booking: {
        id: row.bookingId,
        reference: row.reference,
        guestName: `${row.firstName} ${row.lastName}`.trim(),
        guestEmail: kind === "payment_not_received" && contactAllowed ? row.email : null,
        roomName: row.roomName,
        roomCount: row.roomCount,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        adults: row.adults,
        children: row.children,
        totalAmount: row.totalAmount,
        currency: row.currency,
        paymentStatus: row.paymentStatus,
        // Read from the booking as it is now, not from the event.
        awaiting:
          row.lifecycleStatus === "pending_payment"
            ? row.paymentStatus === "authorized" || row.hadHostDeadline
              ? "acceptance"
              : "payment"
            : null,
        cancelledBy: details.cancelledBy ?? null,
        cancelReason: details.cancelReason ?? null,
        change: details.change ?? null,
      },
    });
  }
  return out;
}

function syncAlert(
  rows: SyncStatusRow[],
  sources: HostNotificationSources,
  viewer: HostNotificationViewer,
): HostNotificationSyncAlert | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.domain.localeCompare(b.domain));
  const episode = sorted
    .map((row) => `${row.domain}.${row.lastSuccessAt ? row.lastSuccessAt.getTime() : "never"}`)
    .join(":");
  const key = `channel-sync:${sorted[0]!.connectionId}:${episode}`;
  const successes = rows.map((row) => row.lastSuccessAt?.getTime() ?? null);
  const lastSuccess = successes.includes(null) ? null : Math.min(...(successes as number[]));
  const domains = sorted.map((row) => row.domain);
  return {
    key,
    read: sources.readKeys.has(key),
    domains,
    failedAt: new Date(Math.max(...rows.map((row) => row.lastAttemptAt.getTime()))).toISOString(),
    lastSuccessAt: lastSuccess === null ? null : new Date(lastSuccess).toISOString(),
    canRetry: domains.every((domain) => viewer.retrySyncDomains.includes(domain)),
    canViewDetails: viewer.canOpenChannelManager,
  };
}

function promoNotifications(
  rows: PromoRow[],
  sources: HostNotificationSources,
): HostNotification[] {
  const out: HostNotification[] = [];
  for (const row of rows) {
    const promo = {
      id: row.id,
      code: row.code,
      validUntil: row.validUntil,
      uses: row.uses,
      maxUses: row.maxUses,
    };
    if (row.limitReachedAt) {
      const key = `promo-limit:${row.id}:${row.maxUses}`;
      out.push({
        key,
        kind: "promo_limit_reached",
        category: "needs_action",
        occurredAt: row.limitReachedAt.toISOString(),
        read: sources.readKeys.has(key),
        promo,
      });
    } else if (row.endingSince && row.validUntil) {
      const key = `promo-ending:${row.id}:${row.validUntil}`;
      out.push({
        key,
        kind: "promo_ending",
        category: "needs_action",
        occurredAt: row.endingSince.toISOString(),
        read: sources.readKeys.has(key),
        promo,
      });
    }
  }
  return out;
}

function allNotifications(
  sources: HostNotificationSources,
  viewer: HostNotificationViewer,
): HostNotification[] {
  return [
    ...bookingNotifications(sources, viewer),
    ...(viewer.canReadPromos ? promoNotifications(sources.promos, sources) : []),
    ...sources.members.map((row): HostNotification => {
      const key = `team-joined:${row.membershipId}`;
      return {
        key,
        kind: "team_member_joined",
        category: "updates",
        occurredAt: row.joinedAt.toISOString(),
        read: sources.readKeys.has(key),
        member: { name: row.name, role: row.role },
      };
    }),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.key.localeCompare(b.key));
}

const URGENT: ReadonlySet<HostNotificationKind> = new Set(["payment_not_received"]);

/** Turns the source rows into the bell's feed: newest first, the newest 50 of each tab's category, and
 * unread counts over all 30 days. */
export function buildHostNotificationFeed(
  sources: HostNotificationSources,
  viewer: HostNotificationViewer,
  now: Date = new Date(),
): HostNotificationFeed {
  const items = allNotifications(sources, viewer);
  const alert = syncAlert(sources.syncStatuses, sources, viewer);
  const unread: HostNotificationUnread = { all: 0, bookings: 0, needsAction: 0, updates: 0 };
  // A failing sync keeps the badge red until it is fixed, not just until it is read (VAY-2349).
  let urgent = alert !== null;
  if (alert && !alert.read) {
    unread.all += 1;
    unread.needsAction += 1;
  }
  const shown: Record<HostNotificationCategory, number> = {
    bookings: 0,
    needs_action: 0,
    updates: 0,
  };
  const listed: HostNotification[] = [];
  for (const item of items) {
    if (shown[item.category] < HOST_NOTIFICATION_LIST_LIMIT) {
      shown[item.category] += 1;
      listed.push(item);
    }
    if (item.read) continue;
    unread.all += 1;
    if (item.category === "bookings") unread.bookings += 1;
    else if (item.category === "needs_action") unread.needsAction += 1;
    else unread.updates += 1;
    if (URGENT.has(item.kind)) urgent = true;
  }
  return {
    generatedAt: now.toISOString(),
    timeZone: sources.timeZone,
    items: listed,
    syncAlert: alert,
    unread,
    badge: urgent ? "red" : unread.all > 0 ? "blue" : "none",
  };
}

/** The keys "Mark all read" marks: every item up to when the person's list was read (beyond the rows
 * shown), and the sync card if it is still the one they saw. */
export function readAllKeys(
  sources: HostNotificationSources,
  viewer: HostNotificationViewer,
  seen: HostNotificationReadAll,
): string[] {
  const before = seen.before.getTime();
  const keys = allNotifications(sources, viewer)
    .filter((item) => !item.read && Date.parse(item.occurredAt) <= before)
    .map((item) => item.key);
  const alert = syncAlert(sources.syncStatuses, sources, viewer);
  if (alert && !alert.read && alert.key === seen.syncAlertKey) keys.push(alert.key);
  return keys;
}

// ---------------------------------------------------------------- SQL

const PROPERTY_SQL = `
SELECT COALESCE(NULLIF(location.timezone, ''), 'UTC') AS "timeZone"
FROM hotel_catalog.properties property
LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
WHERE property.id = $1::uuid`;

// Booking-page bookings only (VAY-2349 D2): PMS-made and channel manager bookings come later (VAY-2351).
// The person's own changes are left out (D7). Every status event writer also bumps the booking's
// updated_at, so bookings untouched for 30 days are skipped through the (property_id, updated_at) index.
// No row cap: the unread counts, the badge and "Mark all read" need every event in the window.
const BOOKING_EVENTS_SQL = `
SELECT event.id::text AS "eventId", event.event_type AS "eventType",
  event.actor_type AS "actorType", event.occurred_at AS "occurredAt", event.event_payload AS payload,
  booking.id::text AS "bookingId", booking.public_reference AS reference,
  booking.lifecycle_status AS "lifecycleStatus", booking.payment_status AS "paymentStatus",
  booking.cancellation_reason AS "cancellationReason",
  booking.booking_metadata ->> 'paymentMethod' AS "paymentMethod",
  booking.booking_metadata ? 'hostResponseDeadlineAt' AS "hadHostDeadline",
  booking.check_in::text AS "checkIn", booking.check_out::text AS "checkOut",
  booking.adults, booking.children, booking.room_count AS "roomCount",
  booking.total_amount::text AS "totalAmount", booking.currency,
  COALESCE(booker.first_name, '') AS "firstName", COALESCE(booker.last_name, '') AS "lastName",
  booker.email,
  CASE WHEN event.event_type IN ('guest_booking.canceled', 'guest_booking.expired')
    THEN ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL} ELSE FALSE END AS "contactAccepted",
  COALESCE(room_type.name, (
    SELECT selected_type.name FROM pms.room_types selected_type
    WHERE selected_type.id::text = booking.booking_metadata #>> '{pricingSelections,0,roomTypeId}'
      AND selected_type.property_id = booking.property_id
  ), '') AS "roomName"
FROM booking.guest_bookings booking
JOIN booking.booking_status_events event ON event.guest_booking_id = booking.id
LEFT JOIN LATERAL (
  SELECT guest.first_name, guest.last_name, guest.email
  FROM booking.booking_guests guest
  WHERE guest.guest_booking_id = booking.id
  ORDER BY CASE guest.guest_role WHEN 'booker' THEN 0 WHEN 'primary_guest' THEN 1 ELSE 2 END,
    guest.created_at, guest.id
  LIMIT 1
) booker ON TRUE
LEFT JOIN LATERAL (
  SELECT assignment.room_type_id
  FROM pms.operational_booking_assignments assignment
  WHERE assignment.guest_booking_id = booking.id AND assignment.property_id = booking.property_id
  ORDER BY assignment.position, assignment.created_at, assignment.id
  LIMIT 1
) primary_assignment ON TRUE
LEFT JOIN pms.room_types room_type
  ON room_type.id = primary_assignment.room_type_id AND room_type.property_id = booking.property_id
WHERE booking.property_id = $1::uuid
  AND booking.updated_at >= now() - make_interval(days => $2)
  AND booking.source_system <> 'pms'
  AND event.occurred_at >= now() - make_interval(days => $2)
  AND event.event_type = ANY($3::text[])
  AND event.actor_type <> 'migration'
  AND event.actor_user_id IS DISTINCT FROM $4::uuid
ORDER BY event.occurred_at DESC, event.id`;

// The channel manager's availability (ari) or booking sync is failing: its retries ran out, or its
// scheduled retry is more than the grace period late. A failure being retried on time doesn't show.
const SYNC_SQL = `
SELECT status.connection_id::text AS "connectionId", status.sync_domain AS domain,
  status.last_attempt_at AS "lastAttemptAt", status.last_success_at AS "lastSuccessAt"
FROM pms.channel_sync_status status
JOIN pms.channel_connections connection
  ON connection.id = status.connection_id AND connection.property_id = status.property_id
WHERE status.property_id = $1::uuid
  AND connection.provider = 'channex'
  AND connection.connection_status IN ('connected', 'degraded')
  AND status.sync_domain IN ('ari', 'booking')
  AND status.last_attempt_at IS NOT NULL
  AND (status.last_success_at IS NULL OR status.last_success_at < status.last_attempt_at)
  AND (status.status = 'failed' OR (
    status.status = 'degraded'
    AND COALESCE(status.retry_after, status.last_attempt_at) < now() - make_interval(mins => $2)
  ))`;

// Active promo codes that end within 7 days (property calendar, still usable) or have used up their limit.
// "Since" is when the code entered the 7 days, or when it was created if later; "reached" is its last use.
const PROMOS_SQL = `
WITH today AS (SELECT (now() AT TIME ZONE $2)::date AS day)
SELECT promo.id::text AS id, promo.code, promo.valid_until::text AS "validUntil",
  promo.current_uses AS uses, promo.max_uses AS "maxUses",
  CASE WHEN promo.current_uses < promo.max_uses
    THEN GREATEST(promo.created_at, ((promo.valid_until - $3::int)::timestamp AT TIME ZONE $2))
  END AS "endingSince",
  CASE WHEN promo.current_uses >= promo.max_uses THEN COALESCE((
    SELECT max(application.created_at) FROM booking.promo_applications application
    WHERE application.promo_definition_id = promo.id AND application.application_status = 'applied'
  ), promo.updated_at) END AS "limitReachedAt"
FROM booking.promo_definitions promo, today
WHERE promo.property_id = $1::uuid
  AND promo.status = 'active' AND promo.is_active
  AND (promo.valid_until IS NULL OR promo.valid_until >= today.day)
  AND (
    promo.current_uses >= promo.max_uses
    OR promo.valid_until <= today.day + $3::int
  )`;

// Staff who joined the hotel account with access to this property: an invitation's first acceptance
// sets invited_at. Owners, the person themself and people no longer active are left out. Only the name
// shows: never the colleague's email.
const MEMBERS_SQL = `
SELECT membership.id::text AS "membershipId", membership.invited_at AS "joinedAt",
  NULLIF(btrim(person.name), '') AS name,
  COALESCE(role.name, membership.role_key) AS role
FROM identity.organization_memberships membership
JOIN identity.users person ON person.id = membership.user_id AND person.status = 'active'
LEFT JOIN identity.organization_roles role ON role.id = membership.role_definition_id
WHERE membership.organization_id = $1::uuid
  AND membership.status = 'active'
  AND membership.access_origin = 'agency'
  AND membership.role_key NOT IN ('hotel_owner', 'owner', 'operator', 'external_owner')
  AND membership.invited_at >= now() - make_interval(days => $3)
  AND membership.user_id <> $4::uuid
  AND (membership.property_access_mode = 'all' OR EXISTS (
    SELECT 1 FROM identity.membership_property_assignments assignment
    WHERE assignment.membership_id = membership.id AND assignment.property_id = $2::uuid
  ))`;

const READ_KEYS_SQL = `
SELECT notification_key AS key FROM booking.host_notification_reads
WHERE user_id = $1::uuid AND property_id = $2::uuid`;

// Records the marks (a repeated mark refreshes its time) and drops the person's other marks older than
// 60 days, on every property.
const MARK_SQL = `
WITH pruned AS (
  DELETE FROM booking.host_notification_reads
  WHERE user_id = $1::uuid AND read_at < now() - make_interval(days => $4)
    AND NOT (property_id = $2::uuid AND notification_key = ANY($3::text[]))
)
INSERT INTO booking.host_notification_reads (user_id, property_id, notification_key)
SELECT $1::uuid, $2::uuid, key FROM unnest($3::text[]) AS key
ON CONFLICT (user_id, property_id, notification_key) DO UPDATE SET read_at = EXCLUDED.read_at`;

type Client = Pick<pg.PoolClient, "query">;

/** One short transaction per call on one connection, with a statement timeout set inside it: a pool-level
 * timeout would shrink the pool to one connection. */
export function createPgBookingHostNotificationsRepository(
  pool: pg.Pool,
): BookingHostNotificationsRepository {
  async function inTransaction<T>(readOnly: boolean, work: (client: Client) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const rows = async <Row extends QueryResultRow>(
    client: Client,
    text: string,
    values: unknown[],
  ) => (await client.query<Row>(text, values)).rows;

  async function readSources(
    client: Client,
    propertyId: string,
    viewer: HostNotificationViewer,
  ): Promise<HostNotificationSources | null> {
    const property = (await rows<{ timeZone: string }>(client, PROPERTY_SQL, [propertyId]))[0];
    if (!property) return null;
    const bookingEvents = await rows<BookingEventRow>(client, BOOKING_EVENTS_SQL, [
      propertyId,
      HOST_NOTIFICATION_WINDOW_DAYS,
      HOST_NOTIFICATION_BOOKING_EVENTS,
      viewer.userId,
    ]);
    const syncStatuses = await rows<SyncStatusRow>(client, SYNC_SQL, [
      propertyId,
      HOST_NOTIFICATION_SYNC_GRACE_MINUTES,
    ]);
    const promos = viewer.canReadPromos
      ? await rows<PromoRow>(client, PROMOS_SQL, [
          propertyId,
          property.timeZone,
          HOST_NOTIFICATION_PROMO_ENDING_DAYS,
        ])
      : [];
    const members = await rows<MemberRow>(client, MEMBERS_SQL, [
      viewer.organizationId,
      propertyId,
      HOST_NOTIFICATION_WINDOW_DAYS,
      viewer.userId,
    ]);
    const readRows = await rows<{ key: string }>(client, READ_KEYS_SQL, [
      viewer.userId,
      propertyId,
    ]);
    const windowStart = Date.now() - HOST_NOTIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const needsContact =
      viewer.canReadGuestContact &&
      bookingEvents.some((row) => row.paymentMethod === "bank_transfer" && !row.contactAccepted);
    const plan = needsContact ? await readPropertyPlan(client, propertyId) : null;
    return {
      timeZone: property.timeZone,
      bookingEvents,
      syncStatuses,
      // A code that used up its limit long ago no longer shows.
      promos: promos.filter(
        (row) => !row.limitReachedAt || row.limitReachedAt.getTime() >= windowStart,
      ),
      members,
      readKeys: new Set(readRows.map((row) => row.key)),
      guestContactAlways: plan ? propertyCanAccessGuestContact(plan, false) : false,
    };
  }

  const mark = (client: Client, userId: string, propertyId: string, keys: string[]) =>
    client.query(MARK_SQL, [userId, propertyId, keys, HOST_NOTIFICATION_READ_RETENTION_DAYS]);

  return {
    read: (propertyId, viewer) =>
      inTransaction(true, async (client) => {
        const sources = await readSources(client, propertyId, viewer);
        return sources ? buildHostNotificationFeed(sources, viewer) : null;
      }),
    async markRead(propertyId, userId, keys) {
      const valid = [...new Set(keys)].filter(isHostNotificationKey);
      if (valid.length === 0) return;
      await inTransaction(false, (client) => mark(client, userId, propertyId, valid));
    },
    markAllRead: (propertyId, viewer, seen) =>
      inTransaction(false, async (client) => {
        const sources = await readSources(client, propertyId, viewer);
        if (!sources) return;
        const keys = readAllKeys(sources, viewer, seen);
        if (keys.length > 0) await mark(client, viewer.userId, propertyId, keys);
      }),
    async close() {
      await pool.end();
    },
  };
}
