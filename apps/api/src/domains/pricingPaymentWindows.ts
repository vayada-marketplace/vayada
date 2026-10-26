import { randomUUID } from "node:crypto";
import {
  isWindowedPaymentMethod,
  parsePaymentMethodBookingWindows,
  paymentWindowAllows,
  paymentWindowHours,
  type PaymentMethodBookingWindow,
  type PaymentMethodBookingWindows,
} from "@vayada/domain-booking";
import type pg from "pg";
import {
  propertyLocalDate,
  propertyLocalInstant,
  readPricingCheckInPlace,
  type PricingCheckInPlace,
} from "./pricingManualPaymentLead.js";

type Queryable = Pick<pg.PoolClient, "query">;

/** The hotel's booking windows per payment method (VAY-2348); a method without one has no limit. */
export async function readPaymentMethodWindows(
  client: Queryable,
  propertyId: string,
): Promise<PaymentMethodBookingWindows> {
  const rows = (
    await client.query<{ method: string; kind: string; amount: number; unit: string }>(
      `SELECT payment_method AS method, window_kind AS kind, amount, unit
       FROM finance.payment_method_booking_windows WHERE property_id = $1`,
      [propertyId],
    )
  ).rows;
  const parsed = parsePaymentMethodBookingWindows(
    Object.fromEntries(
      rows.map(({ method, kind, amount, unit }) => [method, { kind, amount, unit }]),
    ),
  );
  if (!parsed.ok) throw new Error("Payment method booking windows are invalid");
  return parsed.windows;
}

/** Saves the hotel's whole set of windows: methods left out have no limit afterwards. */
export async function replacePaymentMethodWindows(
  pool: Pick<pg.Pool, "connect">,
  input: {
    propertyId: string;
    windows: PaymentMethodBookingWindows;
    audit: { actorUserId: string; requestId: string; correlationId: string | null };
  },
): Promise<PaymentMethodBookingWindows> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
    // Two saves at once must not mix their sets.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('finance.payment_windows'), hashtext($1::uuid::text))",
      [input.propertyId],
    );
    const entries = Object.entries(input.windows) as [string, PaymentMethodBookingWindow][];
    await client.query(
      `DELETE FROM finance.payment_method_booking_windows
       WHERE property_id = $1 AND NOT payment_method = ANY($2::text[])`,
      [input.propertyId, entries.map(([method]) => method)],
    );
    for (const [method, window] of entries)
      await client.query(
        `INSERT INTO finance.payment_method_booking_windows
           (property_id, payment_method, window_kind, amount, unit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (property_id, payment_method) DO UPDATE
           SET window_kind = EXCLUDED.window_kind, amount = EXCLUDED.amount, unit = EXCLUDED.unit,
             updated_at = now()`,
        [input.propertyId, method, window.kind, window.amount, window.unit],
      );
    await client.query(
      `INSERT INTO platform.product_audit_events (
         audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
         actor_type, actor_user_id, target_resource_product, target_resource_type,
         target_resource_id, correlation_id, causation_id, redacted_payload, retention_class,
         privacy_scope
       ) VALUES ($1, 'finance', 'finance.payment_method_windows.updated', now(), 'property', NULL,
         $2::uuid, 'user', $3::uuid, 'finance', 'payment_settings', $2::uuid::text, $4, $5,
         $6::jsonb, 'financial', 'internal')`,
      [
        `finance.payment-method-windows:${input.propertyId}:${randomUUID()}`,
        input.propertyId,
        input.audit.actorUserId,
        input.audit.correlationId ?? input.audit.requestId,
        input.audit.requestId,
        JSON.stringify({ windows: input.windows }),
      ],
    );
    const saved = await readPaymentMethodWindows(client, input.propertyId);
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type PaymentMethodWindowsRepository = {
  read(propertyId: string): Promise<PaymentMethodBookingWindows>;
  replace(
    input: Parameters<typeof replacePaymentMethodWindows>[1],
  ): Promise<PaymentMethodBookingWindows>;
  close?(): Promise<void>;
};

/** Booking Admin's read and save, on its own small pool. */
export function createPaymentMethodWindowsRepository(
  pool: Pick<pg.Pool, "query" | "connect" | "end">,
): PaymentMethodWindowsRepository {
  return {
    read: (propertyId) => readPaymentMethodWindows(pool, propertyId),
    replace: (input) => replacePaymentMethodWindows(pool, input),
    close: () => pool.end(),
  };
}

/** Whether the method's booking window lets a guest book this check-in now, by the property's
 * time zone and check-in time and the database clock. No window: yes; unknown place: no. */
export async function pricingPaymentWindowAllows(
  client: Queryable,
  propertyId: string,
  method: unknown,
  checkIn: string,
): Promise<boolean> {
  if (!isWindowedPaymentMethod(method)) return true;
  const window = (await readPaymentMethodWindows(client, propertyId))[method];
  if (!window) return true;
  const read = await readPricingCheckInPlace(client, propertyId);
  const start =
    read && propertyLocalInstant(checkIn, read.place.checkInTime ?? "00:00", read.place.timeZone);
  return !!read && !!start && paymentWindowAllows(window, start.getTime() - read.now.getTime());
}

/**
 * The property-local arrival dates (YYYY-MM-DD) the window allows when booking at `now`: from
 * `from` on for "at least", up to `through` for "within". Null when the place can't be read.
 */
export function paymentWindowArrivalRange(
  window: PaymentMethodBookingWindow,
  place: PricingCheckInPlace,
  now: Date,
): { from: string } | { through: string } | null {
  // The boundary date is within a day of the date `window` hours from now.
  const near = propertyLocalDate(
    new Date(now.getTime() + paymentWindowHours(window) * 3_600_000),
    place.timeZone,
  );
  if (!near) return null;
  const allows = (checkIn: string) => {
    const start = propertyLocalInstant(checkIn, place.checkInTime ?? "00:00", place.timeZone);
    return start ? paymentWindowAllows(window, start.getTime() - now.getTime()) : null;
  };
  const steps = window.kind === "at_least" ? [-1, 0, 1, 2] : [1, 0, -1, -2];
  for (const step of steps) {
    const checkIn = addDays(near, step);
    const allowed = allows(checkIn);
    if (allowed === null) return null;
    if (allowed) return window.kind === "at_least" ? { from: checkIn } : { through: checkIn };
  }
  return null;
}

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}
