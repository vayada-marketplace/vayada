import { createHmac, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";

/**
 * VAY-2438: signed webhooks to connected partner apps (contract "What Vayada accepts and sends",
 * section 3). Events wait in platform.outbox_events (destination 'partner_webhook'); a job POSTs each
 * one to the app's webhook address with a Vayada-Signature header and retries anything but a 2xx
 * answered within 10 seconds after 1 minute, 5 minutes, 30 minutes and 2 hours, then every 6 hours
 * for 3 days. After that the event is marked failed and logged as an error.
 *
 * The app's signing secret is never stored: it is an HMAC of the app's client id and secret version
 * under PARTNER_WEBHOOK_SIGNING_KEY (next-api's environment), handed to the app once at registration.
 */
export const PARTNER_WEBHOOK_DESTINATION = "partner_webhook";
export const RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200, ...Array<number>(12).fill(21_600)];
/** The first try plus every retry. */
export const MAX_DELIVERY_ATTEMPTS = 1 + RETRY_DELAYS_SECONDS.length;
export const DELIVERY_TIMEOUT_MS = 10_000;

export type PartnerEventType =
  | "booking.confirmed"
  | "booking.changed"
  | "booking.cancelled"
  | "booking.no_show"
  | "booking.checked_out"
  | "connection.revoked";

export function deriveWebhookSigningSecret(
  signingKey: Buffer,
  clientId: string,
  secretVersion: number,
): string {
  const mac = createHmac("sha256", signingKey)
    .update(`vayada-partner-webhook:${clientId}:${secretVersion}`)
    .digest("base64url");
  return `vyp_ws_${mac}`;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export function webhookSignature(secret: string, rawBody: string, unixSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${unixSeconds}.${rawBody}`).digest("hex");
  return `t=${unixSeconds},v1=${v1}`;
}

/** PARTNER_WEBHOOK_SIGNING_KEY: base64 of at least 32 random bytes. */
export function parseWebhookSigningKey(value: string | undefined): Buffer | null {
  if (!value?.trim()) return null;
  const key = Buffer.from(value.trim(), "base64");
  if (key.length < 32)
    throw new Error("PARTNER_WEBHOOK_SIGNING_KEY must be base64 of at least 32 bytes");
  return key;
}

type Queryable = Pick<PoolClient, "query">;

/**
 * Writes one event for the app, in the caller's transaction. Nothing is written for an app without
 * a webhook address. The domain event keeps only what it is about; the outbox row holds the body.
 */
export async function enqueuePartnerEvent(
  client: Queryable,
  input: {
    appId: string;
    propertyId: string;
    type: PartnerEventType;
    occurredAt: string;
    booking?: { bookingId: string; version: number } & Record<string, unknown>;
  },
): Promise<string | null> {
  const id = randomUUID();
  const body = {
    id,
    type: input.type,
    occurredAt: input.occurredAt,
    hotelId: input.propertyId,
    ...(input.booking ? { booking: input.booking } : {}),
  };
  const result = await client.query<{ id: string }>(
    `WITH app AS (
       SELECT id FROM distribution.external_api_clients
       WHERE id = $2::uuid AND webhook_url IS NOT NULL
     ), event AS (
       INSERT INTO platform.domain_events (
         source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
         resource_product, resource_type, resource_id, payload, privacy_scope
       )
       SELECT 'distribution', 'partner_event:' || $1, $4, $5::timestamptz, 'property', $3::uuid,
              'distribution', 'partner_event', $1,
              jsonb_build_object('appId', $2::text, 'type', $4::text,
                                 'bookingId', $7::text, 'version', $8::int),
              'confidential'
       FROM app
       RETURNING id
     )
     INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope, property_id,
       resource_product, resource_type, resource_id, max_attempts, available_at, payload,
       outbox_metadata
     )
     SELECT event.id, $1, '${PARTNER_WEBHOOK_DESTINATION}', $4, 'property', $3::uuid,
            'distribution', 'partner_event', $1, ${MAX_DELIVERY_ATTEMPTS}, $5::timestamptz, $6::jsonb,
            jsonb_build_object('appId', $2::text)
     FROM event
     RETURNING id::text`,
    [
      id,
      input.appId,
      input.propertyId,
      input.type,
      input.occurredAt,
      JSON.stringify(body),
      input.booking?.bookingId ?? null,
      input.booking?.version ?? null,
    ],
  );
  return result.rows[0] ? id : null;
}

export type DeliveryResult = { delivered: number; retrying: number; failed: string[] };

type Leased = {
  id: string;
  eventId: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  clientId: string | null;
  webhookUrl: string | null;
  secretVersion: number | null;
  appActive: boolean;
};

/** Delivers due events, one at a time, until `limit` were tried. */
export async function deliverPartnerWebhooks(options: {
  pool: Pick<pg.Pool, "query">;
  signingKey: Buffer;
  fetch?: typeof fetch;
  now?: () => Date;
  limit?: number;
  log?: { error(details: Record<string, unknown>, message: string): void };
}): Promise<DeliveryResult> {
  const { pool, signingKey } = options;
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const result: DeliveryResult = { delivered: 0, retrying: 0, failed: [] };
  const leased = await pool.query<Leased>(
    `WITH due AS (
       SELECT id FROM platform.outbox_events
       WHERE destination = '${PARTNER_WEBHOOK_DESTINATION}'
         AND ((status = 'pending' AND available_at <= $1::timestamptz)
              OR (status = 'leased' AND leased_until < $1::timestamptz))
       ORDER BY available_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     ), leased AS (
       UPDATE platform.outbox_events outbox
       SET status = 'leased', leased_until = $1::timestamptz + interval '2 minutes',
           updated_at = $1::timestamptz
       FROM due WHERE outbox.id = due.id
       RETURNING outbox.*
     )
     SELECT leased.id::text, leased.outbox_key AS "eventId", leased.payload,
            leased.attempts_count AS attempts, leased.max_attempts AS "maxAttempts",
            app.public_client_id AS "clientId", app.webhook_url AS "webhookUrl",
            app.webhook_secret_version AS "secretVersion",
            COALESCE(app.status = 'active', false) AS "appActive"
     FROM leased
     LEFT JOIN distribution.external_api_clients app
       ON app.id::text = leased.outbox_metadata->>'appId'
     ORDER BY leased.available_at, leased.id`,
    [now().toISOString(), options.limit ?? 10],
  );

  for (const event of leased.rows) {
    let outcome: string;
    if (!event.appActive || !event.webhookUrl || !event.clientId || !event.secretVersion) {
      outcome = "app_unavailable";
    } else {
      const rawBody = JSON.stringify(event.payload);
      const secret = deriveWebhookSigningSecret(signingKey, event.clientId, event.secretVersion);
      try {
        const response = await send(event.webhookUrl, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          headers: {
            "content-type": "application/json",
            "user-agent": "Vayada-Webhooks/1",
            "vayada-signature": webhookSignature(
              secret,
              rawBody,
              Math.floor(now().getTime() / 1000),
            ),
          },
          body: rawBody,
        });
        outcome =
          response.status >= 200 && response.status < 300 ? "ok" : `http_${response.status}`;
      } catch (error) {
        outcome =
          error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
      }
    }

    const at = now().toISOString();
    if (outcome === "ok") {
      await pool.query(
        `UPDATE platform.outbox_events
         SET status = 'published', published_at = $2::timestamptz, leased_until = NULL,
             attempts_count = attempts_count + 1, updated_at = $2::timestamptz
         WHERE id = $1::uuid AND status = 'leased'`,
        [event.id, at],
      );
      result.delivered += 1;
      continue;
    }
    const attempts = event.attempts + 1;
    const exhausted = attempts >= event.maxAttempts || outcome === "app_unavailable";
    await pool.query(
      `UPDATE platform.outbox_events
       SET status = $3, leased_until = NULL, attempts_count = $4,
           available_at = $2::timestamptz + make_interval(secs => $5),
           outbox_metadata = outbox_metadata || jsonb_build_object('lastOutcome', $6::text,
                                                                    'lastTriedAt', $2::text),
           updated_at = $2::timestamptz
       WHERE id = $1::uuid AND status = 'leased'`,
      [
        event.id,
        at,
        exhausted ? "failed" : "pending",
        Math.min(attempts, event.maxAttempts),
        exhausted ? 0 : (RETRY_DELAYS_SECONDS[attempts - 1] ?? RETRY_DELAYS_SECONDS.at(-1)!),
        outcome,
      ],
    );
    if (exhausted) {
      result.failed.push(event.eventId);
      // Where the team sees it: an error line per event that will not be sent again.
      options.log?.error(
        { eventId: event.eventId, clientId: event.clientId, attempts, outcome },
        "Partner webhook event failed for good",
      );
    } else {
      result.retrying += 1;
    }
  }
  return result;
}
