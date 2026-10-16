-- VAY-2212 (after the API writes booking-page analytics to distribution.booking_web_events, 0486):
-- 1. copy the analytics rows the log received since 0486 (0486's copy rules);
-- 2. blank the analytics rows' copies in the append-only log, keeping only that an event happened
--    for a hotel at a time: no session id, properties or request traces;
-- 3. strip old affiliate click rows (VAY-2209/2215, approved by Flamur): no landing URL, referrer,
--    free metadata, IP or user-agent hash or request id; the click id becomes the correlation id.
-- Keys made from a request or session id are replaced by keys made from the row id. Nothing reads
-- these keys, and no writer adds such rows any more.
-- The append-only triggers are switched off only inside this transaction (0153 pattern) and come
-- back unchanged, so the Channex worker's trigger catalog digest stays the same.
SET LOCAL lock_timeout = '5s';

-- Lock both log tables before reading or changing anything, so a busy table fails the run up
-- front and the copy below sees every row the blanking then touches.
LOCK TABLE platform.domain_events, platform.product_audit_events IN SHARE ROW EXCLUSIVE MODE;

-- Only after the API writes analytics to the new table: rows the old writer logged after this
-- would be neither copied nor blanked. A booking-page event logged in the last hour means it
-- still writes here (a safety net; the release order is the control).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM platform.domain_events
    WHERE resource_product = 'distribution' AND resource_type = 'booking_web_hotel'
      AND left(event_type, 12) = 'booking_web.' AND occurred_at > now() - INTERVAL '1 hour'
  ) THEN
    RAISE EXCEPTION 'booking-page events are still logged; release the API that writes them to distribution.booking_web_events first';
  END IF;
END;
$$;

-- 1. Rows written to the log between 0486 and the API's switch to the new table: 0486's copy,
-- limited to rows recorded since a day before 0486 ran (all rows if 0486's ledger row is missing).
INSERT INTO distribution.booking_web_events
  (property_id, event_type, event_id, session_id, metadata, traffic_class, occurred_at, recorded_at)
SELECT source.property_id, source.event_type, source.event_id, source.session_id,
  source.metadata, source.traffic_class, source.occurred_at, source.recorded_at
FROM (
  SELECT
    COALESCE(event.property_id, (
      SELECT CASE WHEN count(DISTINCT slug.property_id) = 1
        THEN (array_agg(slug.property_id))[1] END
      FROM hotel_catalog.property_slugs slug
      WHERE event.tenant_scope = 'external' AND slug.slug = event.resource_id
    )) AS property_id,
    substring(event.event_type FROM 13) AS event_type,
    CASE WHEN event.payload ->> 'eventId' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
      THEN (event.payload ->> 'eventId')::uuid ELSE event.id END AS event_id,
    CASE WHEN event.payload ->> 'sessionId' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
      THEN (event.payload ->> 'sessionId')::uuid END AS session_id,
    (
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      FROM jsonb_each(CASE WHEN jsonb_typeof(event.payload -> 'metadata') = 'object'
        THEN event.payload -> 'metadata' ELSE '{}'::jsonb END) AS entry
      WHERE CASE entry.key
        WHEN 'funnelVersion' THEN entry.value = '1'::jsonb
        WHEN 'funnelSequence' THEN jsonb_typeof(entry.value) = 'number'
          AND entry.value #>> '{}' ~ '^[1-9][0-9]{0,8}$'
        WHEN 'extrasShown' THEN jsonb_typeof(entry.value) = 'boolean'
        WHEN 'extrasChosen' THEN jsonb_typeof(entry.value) = 'boolean'
        WHEN 'roomTypeId' THEN jsonb_typeof(entry.value) = 'string'
          AND entry.value #>> '{}' ~ '^[A-Za-z0-9_-]{1,64}$'
        -- Any other key has a fixed list; a key with no list is dropped (NULL).
        ELSE jsonb_typeof(entry.value) = 'string' AND entry.value #>> '{}' = ANY (CASE entry.key
          WHEN 'paymentMethod' THEN ARRAY['card', 'bank_transfer', 'pay_at_property', 'xendit',
            'paypal']
          WHEN 'entry' THEN ARRAY['room_card', 'rooms_form']
          WHEN 'step' THEN ARRAY['rooms', 'extras', 'details', 'payment']
          WHEN 'mode' THEN ARRAY['instant', 'request']
          WHEN 'outcome' THEN ARRAY['confirmed', 'requested', 'awaiting_payment']
          WHEN 'reason' THEN ARRAY['price_expired', 'price_refused', 'pricing_failed',
            'booking_unavailable', 'booking_uncertain', 'payment_failed']
          WHEN 'code' THEN ARRAY['QUOTE_REFRESH_REQUIRED', 'PRICING_UNAVAILABLE',
            'PRICING_RETIRED', 'PROMO_CODES_UNAVAILABLE', 'ADDONS_UNAVAILABLE',
            'MANUAL_PAYMENT_TOO_SOON', 'MANUAL_PAYMENT_UNAVAILABLE', 'CARD_PAYMENT_UNAVAILABLE',
            'REQUEST_ACCEPTANCE_UNAVAILABLE']
        END)
      END
    ) AS metadata,
    CASE WHEN event.event_metadata ->> 'trafficClass' = 'test'
        OR event.payload -> 'metadata' -> 'isTestData' = 'true'::jsonb
        OR event.payload -> 'metadata' -> 'testData' = 'true'::jsonb
      THEN 'test' ELSE 'human' END AS traffic_class,
    event.occurred_at,
    event.recorded_at
  FROM platform.domain_events event
  WHERE event.source_system = 'distribution'
    AND event.resource_product = 'distribution'
    AND event.resource_type = 'booking_web_hotel'
    AND left(event.event_type, 12) = 'booking_web.'
    AND event.event_status IN ('recorded', 'projected')
    AND event.occurred_at >= now() - INTERVAL '13 months'
    AND event.recorded_at >= COALESCE((
      SELECT min(applied_at) - INTERVAL '1 day' FROM platform.schema_migrations
      WHERE version = '0486' AND status = 'applied'), '-infinity'::timestamptz)
    AND COALESCE(event.event_metadata ->> 'trafficClass', 'human') <> 'bot'
) AS source
WHERE source.property_id IS NOT NULL
  AND source.event_type ~ '^[a-z][a-z_]{0,63}$'
-- When retries share an event id, the first occurrence is the one kept.
ORDER BY source.occurred_at, source.recorded_at
ON CONFLICT (property_id, event_id) DO NOTHING;

ALTER TABLE platform.domain_events DISABLE TRIGGER trg_platform_domain_events_append_only;
ALTER TABLE platform.product_audit_events DISABLE TRIGGER trg_platform_product_audit_events_append_only;

-- 2. The log keeps "a booking-page event happened at this hotel at this time": no session (it
-- was the correlation id and in the payload), no properties, and no request traces, also not in
-- the keys (made from the event, request or session id).
UPDATE platform.product_audit_events audit
SET redacted_payload = '{}'::jsonb,
    audit_metadata = jsonb_strip_nulls(jsonb_build_object(
      'source', audit.audit_metadata -> 'source',
      'trafficClass', audit.audit_metadata -> 'trafficClass')),
    correlation_id = NULL,
    audit_key = 'booking-web:telemetry-blanked:' || audit.domain_event_id::text
WHERE audit.product = 'distribution'
  AND audit.action = 'booking_web.telemetry.recorded'
  AND audit.target_resource_product = 'distribution'
  AND audit.target_resource_type = 'booking_web_hotel';

UPDATE platform.domain_events event
SET payload = '{}'::jsonb,
    event_metadata = jsonb_strip_nulls(jsonb_build_object(
      'source', event.event_metadata -> 'source',
      'trafficClass', event.event_metadata -> 'trafficClass')),
    correlation_id = NULL,
    event_key = 'booking-web:telemetry-blanked:' || event.id::text,
    idempotency_key_hash = NULL
WHERE event.source_system = 'distribution'
  AND event.resource_product = 'distribution'
  AND event.resource_type = 'booking_web_hotel'
  AND left(event.event_type, 12) = 'booking_web.';

-- 3. Affiliate clicks keep their click id, hotel, referral code and session. A correlation id that
-- was the request id becomes the click id (as the API writes it since VAY-2209/2215), or NULL for
-- clicks from before 2026-09-09, which have none. Their keys were made from the session or request
-- id; clicks since then are keyed by the random click id and keep their keys.
UPDATE platform.product_audit_events audit
SET redacted_payload = audit.redacted_payload - 'landingUrl' - 'referrer' - 'metadata',
    audit_metadata = audit.audit_metadata - 'ipAddressHash' - 'userAgentHash' - 'requestId',
    correlation_id = CASE WHEN audit.correlation_id = audit.audit_metadata ->> 'requestId'
      THEN audit.redacted_payload ->> 'clickId' ELSE audit.correlation_id END,
    audit_key = CASE WHEN audit.audit_key LIKE 'booking-web:affiliate-click-v2:%'
      THEN audit.audit_key
      ELSE 'booking-web:affiliate-click-scrubbed:' || event.id::text END
FROM platform.domain_events event
WHERE audit.domain_event_id = event.id
  AND event.source_system = 'marketplace'
  AND event.resource_product = 'marketplace'
  AND event.resource_type = 'affiliate_referral'
  AND event.event_type = 'marketplace.affiliate_click.recorded'
  AND audit.product = 'marketplace'
  AND audit.action = 'affiliate_click.recorded';

UPDATE platform.domain_events event
SET payload = event.payload - 'landingUrl' - 'referrer' - 'metadata',
    event_metadata = event.event_metadata - 'ipAddressHash' - 'userAgentHash' - 'requestId',
    correlation_id = CASE WHEN event.correlation_id = event.event_metadata ->> 'requestId'
      THEN event.payload ->> 'clickId' ELSE event.correlation_id END,
    event_key = CASE WHEN event.event_key LIKE 'booking-web:affiliate-click-v2:%'
      THEN event.event_key
      ELSE 'booking-web:affiliate-click-scrubbed:' || event.id::text END,
    idempotency_key_hash = CASE WHEN event.event_key LIKE 'booking-web:affiliate-click-v2:%'
      THEN event.idempotency_key_hash END
WHERE event.source_system = 'marketplace'
  AND event.resource_product = 'marketplace'
  AND event.resource_type = 'affiliate_referral'
  AND event.event_type = 'marketplace.affiliate_click.recorded';

ALTER TABLE platform.product_audit_events ENABLE TRIGGER trg_platform_product_audit_events_append_only;
ALTER TABLE platform.domain_events ENABLE TRIGGER trg_platform_domain_events_append_only;
