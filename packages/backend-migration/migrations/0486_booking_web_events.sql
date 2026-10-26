-- VAY-2212: booking-page analytics (the consented funnel events) get their own table, outside the
-- append-only domain event log. Until now each event was a platform.domain_events row plus a
-- product_audit_events copy. Both are append-only by trigger and INSERT-only for the API login,
-- so nothing could ever be removed. Here the API deletes rows after 13 months (its retention job).
--
-- A row holds only what the Booking Admin funnel and page views and the platform growth chart
-- read: the hotel, the event type, the browser's random event and session ids, the funnel
-- properties VAY-2197 allows, and whether it is test traffic. There is no slug, request id, or IP
-- or user-agent trace, and bots are not stored.
--
-- The foreign key holds a write lock on hotel_catalog.properties until this commits; fail fast
-- rather than queue every property write behind a busy table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE distribution.booking_web_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  event_type     TEXT        NOT NULL CHECK (event_type ~ '^[a-z][a-z_]{0,63}$'),
  event_id       UUID        NOT NULL,
  -- NULL only on page visits copied from before VAY-2197, which sent no session.
  session_id     UUID,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  traffic_class  TEXT        NOT NULL DEFAULT 'human' CHECK (traffic_class IN ('human', 'test')),
  occurred_at    TIMESTAMPTZ NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_booking_web_events_event UNIQUE (property_id, event_id)
);

CREATE INDEX idx_booking_web_events_property_type_time
  ON distribution.booking_web_events (property_id, event_type, occurred_at);

-- The retention job deletes by age across all hotels.
CREATE INDEX idx_booking_web_events_occurred_at
  ON distribution.booking_web_events (occurred_at);

-- The API writes, reads and deletes these rows. Grant the API login explicitly, so this does not
-- depend on the schema's default privileges (VAY-2054 posture). This is the same DML that a
-- product table gets from those defaults.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'vayada_next_api_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON distribution.booking_web_events TO vayada_next_api_runtime;
  END IF;
END;
$$;

-- Copy the last 13 months, so the charts keep them: every row a reader counts (no bots), keeping
-- only the properties and values VAY-2197 allows (parseFunnelEventMetadata in domain-booking).
-- The endpoint stored any metadata before that, so each value is checked, not just its key.
-- A row written without a hotel id counts when its slug names exactly one hotel, as in the
-- readers. 0487 copies again (rows written during the release) and then blanks the originals.
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
    AND COALESCE(event.event_metadata ->> 'trafficClass', 'human') <> 'bot'
) AS source
WHERE source.property_id IS NOT NULL
  AND source.event_type ~ '^[a-z][a-z_]{0,63}$'
-- When retries share an event id, the first occurrence is the one kept.
ORDER BY source.occurred_at, source.recorded_at
ON CONFLICT (property_id, event_id) DO NOTHING;
