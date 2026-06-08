-- Migration: 0011_intelligence
-- Owner: domain-intelligence
-- See: engineering/ask-intelligence-architecture.md,
--      engineering/ask-intelligence-evidence-contract.md,
--      engineering/target-schema-migration-coverage.md,
--      engineering/target-schema-ownership-map.md
--
-- Creates the Ask Intelligence target schema for metric definitions,
-- metric/setup snapshots, approved evidence tools, conversations, answer runs,
-- tool call traces, and answer audit records.
--
-- Legacy product databases are migration/parity inputs only. Runtime
-- TypeScript code must not use this migration as a reason to read legacy
-- product databases directly or let the model choose arbitrary SQL.

CREATE SCHEMA IF NOT EXISTS intelligence;

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('booking.analytics.read',              'booking',      'Read booking analytics and direct booking performance aggregates'),
  ('booking.settings.read',               'booking',      'Read booking engine setup and settings summaries'),
  ('pms.read',                            'pms',          'Read PMS operational setup summaries'),
  ('pms.analytics.read',                  'pms',          'Read PMS operational analytics aggregates'),
  ('pms.booking.read',                    'pms',          'Read PMS booking and arrival summaries'),
  ('marketplace.collaboration.read',      'marketplace',  'Read marketplace collaboration status summaries'),
  ('finance.summary.read',                'finance',      'Read finance summaries for Ask Intelligence'),
  ('intelligence.ask.read',               'intelligence', 'Use Ask Intelligence read-only evidence tools')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE identity.organization_resource_links
  ADD CONSTRAINT uq_identity_resource_links_id_organization
  UNIQUE (id, organization_id);

ALTER TABLE identity.organization_resource_links
  ADD CONSTRAINT uq_identity_resource_links_id_organization_resource
  UNIQUE (id, organization_id, resource_id);

CREATE FUNCTION intelligence.resource_scope_key(
  resource_scope TEXT,
  organization_id UUID,
  property_id UUID
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN resource_scope = 'platform' THEN 'platform'
    WHEN resource_scope = 'organization' THEN 'organization:' || organization_id::TEXT
    WHEN resource_scope = 'property' THEN 'property:' || organization_id::TEXT || ':' || property_id::TEXT
  END;
$$;

CREATE FUNCTION intelligence.valid_resource_scope(
  resource_scope TEXT,
  organization_id UUID,
  property_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN resource_scope = 'platform' THEN organization_id IS NULL AND property_id IS NULL
    WHEN resource_scope = 'organization' THEN organization_id IS NOT NULL AND property_id IS NULL
    WHEN resource_scope = 'property' THEN organization_id IS NOT NULL AND property_id IS NOT NULL
    ELSE FALSE
  END;
$$;

CREATE FUNCTION intelligence.valid_source_view(
  source_owner TEXT,
  source_view TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE source_owner
    WHEN 'booking' THEN source_view IN ('direct_booking_summary_read_model')
    WHEN 'pms' THEN source_view IN ('pms_operations_summary_read_model')
    WHEN 'finance' THEN source_view IN ('finance_visibility_read_model')
    WHEN 'marketplace' THEN source_view IN ('marketplace_listing_read_model')
    WHEN 'distribution' THEN source_view IN (
      'public_hotel_bookability_profiles',
      'public_quote_read_models',
      'public_room_offer_snapshots'
    )
    WHEN 'hotel_catalog' THEN source_view IN (
      'property_public_profile_read_model',
      'property_setup_status'
    )
    WHEN 'platform' THEN source_view IN ('product_audit_events')
    WHEN 'intelligence' THEN source_view IN (
      'metric_snapshot_runs',
      'setup_completeness_snapshots'
    )
    ELSE FALSE
  END;
$$;

CREATE FUNCTION intelligence.text_has_forbidden_evidence_value(value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT value IS NOT NULL AND (
    value ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
    OR lower(value) ~ '(^|[^a-z0-9_])(select|insert|update|delete|drop|alter|create)([^a-z0-9_]|$).*(^|[^a-z0-9_])(from|into|join|table|values)([^a-z0-9_]|$)'
    OR lower(value) ~ '(^|[^a-z0-9_])(booking_guests|booking_notes_private|guest_email|guest_phone|guest_name|provider_account_id|provider_transaction_id|provider_payment_intent_id|payout_account|private_notes|raw_payload|raw_headers|raw_body|raw_sql|special_requests|room_number)([^a-z0-9_]|$)'
  );
$$;

CREATE FUNCTION intelligence.jsonb_has_forbidden_evidence_key(document JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT distribution.jsonb_has_forbidden_public_key(
    document,
    ARRAY[
      'access_token', 'account_number', 'api_key', 'bank_account',
      'body', 'card_number', 'channel_credentials', 'client_secret',
      'email', 'first_name', 'full_name', 'guest_email', 'guest_name',
      'guest_phone', 'idempotency_key', 'last_name', 'message_body',
      'owner_note', 'password', 'payment_intent', 'phone', 'private_notes',
      'provider_account_id', 'provider_payment_intent_id',
      'provider_transaction_id', 'payout_account', 'raw_body',
      'raw_headers', 'raw_payload', 'raw_secret', 'raw_sql',
      'request_body', 'response_body', 'room_number', 'secret',
      'sensitive_config_ref', 'source_table', 'special_requests',
      'sql', 'stack_trace', 'token', 'webhook_secret'
    ]::TEXT[]
  )
  OR EXISTS (
    WITH RECURSIVE json_walk(value) AS (
      SELECT document
      UNION ALL
      SELECT child.value
      FROM json_walk
      CROSS JOIN LATERAL (
        SELECT object_child.value
        FROM jsonb_each(
          CASE
            WHEN jsonb_typeof(json_walk.value) = 'object'
            THEN json_walk.value
            ELSE '{}'::jsonb
          END
        ) AS object_child(key, value)
        UNION ALL
        SELECT array_child.value
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(json_walk.value) = 'array'
            THEN json_walk.value
            ELSE '[]'::jsonb
          END
        ) AS array_child(value)
      ) AS child(value)
    )
    SELECT 1
    FROM json_walk
    WHERE jsonb_typeof(value) = 'string'
      AND intelligence.text_has_forbidden_evidence_value(value #>> '{}')
  );
$$;

CREATE TABLE intelligence.metric_definitions (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key                 TEXT        NOT NULL,
  display_name               TEXT        NOT NULL,
  description                TEXT,
  product                    TEXT        NOT NULL
                                      CHECK (product IN (
                                        'booking', 'pms', 'finance',
                                        'marketplace', 'distribution',
                                        'hotel_catalog', 'platform'
                                      )),
  metric_category            TEXT        NOT NULL
                                      CHECK (metric_category IN (
                                        'performance', 'funnel', 'revenue',
                                        'operations', 'setup',
                                        'marketplace', 'finance'
                                      )),
  unit                       TEXT        NOT NULL DEFAULT 'count'
                                      CHECK (unit IN (
                                        'count', 'currency', 'percentage',
                                        'ratio', 'duration', 'boolean', 'score'
                                      )),
  default_resource_scope     TEXT        NOT NULL DEFAULT 'property'
                                      CHECK (default_resource_scope IN (
                                        'property', 'organization', 'platform'
                                      )),
  required_permission_key    TEXT        NOT NULL,
  visibility                 TEXT        NOT NULL DEFAULT 'owner'
                                      CHECK (visibility IN (
                                        'owner', 'finance_restricted',
                                        'platform', 'internal'
                                      )),
  freshness_slo_seconds      INTEGER     NOT NULL DEFAULT 86400
                                      CHECK (freshness_slo_seconds > 0),
  pii_policy                 TEXT        NOT NULL DEFAULT 'aggregate_only'
                                      CHECK (pii_policy IN (
                                        'none', 'aggregate_only',
                                        'minimized_pii', 'finance_restricted'
                                      )),
  allowed_filters            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  definition_metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  active                     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_metric_definitions_key
    UNIQUE (metric_key),
  CONSTRAINT uq_intelligence_metric_definitions_id_permission
    UNIQUE (id, required_permission_key),
  CONSTRAINT uq_intelligence_metric_definitions_id_key
    UNIQUE (id, metric_key),
  CONSTRAINT chk_intelligence_metric_definitions_key
    CHECK (metric_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT chk_intelligence_metric_definitions_finance_visibility
    CHECK (
      product <> 'finance'
      OR (
        visibility = 'finance_restricted'
        AND required_permission_key = 'finance.summary.read'
        AND pii_policy = 'finance_restricted'
      )
    ),
  CONSTRAINT chk_intelligence_metric_definitions_private_json
    CHECK (
      NOT intelligence.jsonb_has_forbidden_evidence_key(allowed_filters)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(definition_metadata)
    ),
  CONSTRAINT fk_intelligence_metric_definitions_permission
    FOREIGN KEY (required_permission_key)
    REFERENCES identity.permission_catalog(key)
);

CREATE INDEX idx_intelligence_metric_definitions_product_active
  ON intelligence.metric_definitions (product, metric_category)
  WHERE active = TRUE;

CREATE TABLE intelligence.metric_snapshot_runs (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_definition_id       UUID        NOT NULL,
  metric_key                 TEXT        NOT NULL,
  snapshot_key               TEXT        NOT NULL,
  run_status                 TEXT        NOT NULL DEFAULT 'succeeded'
                                      CHECK (run_status IN (
                                        'queued', 'running', 'succeeded',
                                        'partial', 'failed', 'stale'
                                      )),
  resource_scope             TEXT        NOT NULL DEFAULT 'property'
                                      CHECK (resource_scope IN (
                                        'property', 'organization', 'platform'
                                      )),
  organization_id            UUID,
  property_id                UUID,
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                      intelligence.resource_scope_key(
                                        resource_scope,
                                        organization_id,
                                        property_id
                                      )
                                    ) STORED,
  source_owner               TEXT        NOT NULL
                                      CHECK (source_owner IN (
                                        'booking', 'pms', 'finance',
                                        'marketplace', 'distribution',
                                        'hotel_catalog', 'platform',
                                        'intelligence'
                                      )),
  source_view                TEXT        NOT NULL,
  required_permission_key    TEXT        NOT NULL,
  snapshot_period            TEXT        NOT NULL DEFAULT 'range'
                                      CHECK (snapshot_period IN (
                                        'hour', 'day', 'week', 'month',
                                        'quarter', 'year', 'range', 'adhoc'
                                      )),
  period_start               DATE,
  period_end                 DATE,
  generated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_fresh_at            TIMESTAMPTZ,
  expires_at                 TIMESTAMPTZ,
  freshness_status           TEXT        NOT NULL DEFAULT 'fresh'
                                      CHECK (freshness_status IN (
                                        'fresh', 'stale', 'unknown',
                                        'unavailable'
                                      )),
  quality                    TEXT        NOT NULL DEFAULT 'complete'
                                      CHECK (quality IN (
                                        'complete', 'partial', 'stale',
                                        'estimated', 'hotelier_entered',
                                        'external', 'unavailable'
                                      )),
  sample_size                INTEGER     CHECK (sample_size IS NULL OR sample_size >= 0),
  aggregate_id               TEXT,
  value_summary              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  filters                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  unavailable_reasons        TEXT[]      NOT NULL DEFAULT '{}',
  snapshot_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_metric_snapshot_runs_key
    UNIQUE (snapshot_key),
  CONSTRAINT uq_intelligence_metric_snapshot_runs_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT chk_intelligence_metric_snapshot_runs_scope
    CHECK (intelligence.valid_resource_scope(resource_scope, organization_id, property_id)),
  CONSTRAINT chk_intelligence_metric_snapshot_runs_period
    CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  CONSTRAINT chk_intelligence_metric_snapshot_runs_source_view
    CHECK (intelligence.valid_source_view(source_owner, source_view)),
  CONSTRAINT chk_intelligence_metric_snapshot_runs_terminal
    CHECK (
      run_status NOT IN ('succeeded', 'partial', 'failed', 'stale')
      OR source_fresh_at IS NOT NULL
      OR freshness_status IN ('unknown', 'unavailable')
    ),
  CONSTRAINT chk_intelligence_metric_snapshot_runs_private_json
    CHECK (
      NOT intelligence.jsonb_has_forbidden_evidence_key(value_summary)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(filters)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(source_freshness)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(snapshot_metadata)
    ),
  CONSTRAINT fk_intelligence_metric_snapshot_runs_metric
    FOREIGN KEY (metric_definition_id)
    REFERENCES intelligence.metric_definitions(id),
  CONSTRAINT fk_intelligence_metric_snapshot_runs_metric_key
    FOREIGN KEY (metric_definition_id, metric_key)
    REFERENCES intelligence.metric_definitions(id, metric_key),
  CONSTRAINT fk_intelligence_metric_snapshot_runs_metric_permission
    FOREIGN KEY (metric_definition_id, required_permission_key)
    REFERENCES intelligence.metric_definitions(id, required_permission_key),
  CONSTRAINT fk_intelligence_metric_snapshot_runs_permission
    FOREIGN KEY (required_permission_key)
    REFERENCES identity.permission_catalog(key),
  CONSTRAINT fk_intelligence_metric_snapshot_runs_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_intelligence_metric_snapshot_runs_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
);

CREATE INDEX idx_intelligence_metric_snapshot_runs_resource
  ON intelligence.metric_snapshot_runs (resource_scope, organization_id, property_id, generated_at DESC);

CREATE TABLE intelligence.setup_completeness_snapshots (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_key               TEXT        NOT NULL,
  organization_id            UUID        NOT NULL,
  property_id                UUID        NOT NULL,
  resource_link_id           UUID,
  resource_link_resource_id  TEXT        GENERATED ALWAYS AS (property_id::TEXT) STORED,
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                      intelligence.resource_scope_key(
                                        'property',
                                        organization_id,
                                        property_id
                                      )
                                    ) STORED,
  setup_area                 TEXT        NOT NULL
                                      CHECK (setup_area IN (
                                        'profile', 'policy', 'payment',
                                        'rates', 'inventory', 'images',
                                        'location', 'marketplace',
                                        'agent_readiness', 'overall'
                                      )),
  completion_status          TEXT        NOT NULL DEFAULT 'incomplete'
                                      CHECK (completion_status IN (
                                        'complete', 'incomplete', 'stale',
                                        'blocked', 'not_applicable'
                                      )),
  completeness_score         NUMERIC(5, 2) NOT NULL DEFAULT 0
                                      CHECK (completeness_score BETWEEN 0 AND 100),
  required_permission_key    TEXT        NOT NULL DEFAULT 'booking.settings.read',
  bookability_profile_property_id UUID,
  source_snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_fresh_at            TIMESTAMPTZ,
  freshness_status           TEXT        NOT NULL DEFAULT 'unknown'
                                      CHECK (freshness_status IN (
                                        'fresh', 'stale', 'unknown',
                                        'unavailable'
                                      )),
  missing_items              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  blocking_items             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  stale_items                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source_freshness           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  setup_metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_setup_snapshots_key
    UNIQUE (snapshot_key),
  CONSTRAINT uq_intelligence_setup_snapshots_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT chk_intelligence_setup_snapshots_profile_property
    CHECK (
      bookability_profile_property_id IS NULL
      OR bookability_profile_property_id = property_id
    ),
  CONSTRAINT chk_intelligence_setup_snapshots_complete
    CHECK (
      completion_status <> 'complete'
      OR (
        completeness_score = 100
        AND jsonb_array_length(missing_items) = 0
        AND jsonb_array_length(blocking_items) = 0
      )
    ),
  CONSTRAINT chk_intelligence_setup_snapshots_resource_link_scope
    CHECK (resource_link_id IS NULL OR resource_link_resource_id IS NOT NULL),
  CONSTRAINT chk_intelligence_setup_snapshots_private_json
    CHECK (
      NOT intelligence.jsonb_has_forbidden_evidence_key(missing_items)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(blocking_items)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(stale_items)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(source_freshness)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(setup_metadata)
    ),
  CONSTRAINT fk_intelligence_setup_snapshots_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_intelligence_setup_snapshots_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_intelligence_setup_snapshots_resource_link
    FOREIGN KEY (resource_link_id, organization_id, resource_link_resource_id)
    REFERENCES identity.organization_resource_links(id, organization_id, resource_id),
  CONSTRAINT fk_intelligence_setup_snapshots_permission
    FOREIGN KEY (required_permission_key)
    REFERENCES identity.permission_catalog(key),
  CONSTRAINT fk_intelligence_setup_snapshots_bookability_profile
    FOREIGN KEY (bookability_profile_property_id)
    REFERENCES distribution.public_hotel_bookability_profiles(property_id)
);

CREATE INDEX idx_intelligence_setup_snapshots_property_area
  ON intelligence.setup_completeness_snapshots (property_id, setup_area, source_snapshot_at DESC);

CREATE TABLE intelligence.ai_evidence_catalog (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id                    TEXT        NOT NULL,
  tool_version               TEXT        NOT NULL DEFAULT 'v1',
  display_name               TEXT        NOT NULL,
  product                    TEXT        NOT NULL
                                      CHECK (product IN (
                                        'booking', 'pms', 'finance',
                                        'marketplace', 'distribution',
                                        'hotel_catalog', 'platform'
                                      )),
  source_owner               TEXT        NOT NULL
                                      CHECK (source_owner IN (
                                        'booking', 'pms', 'finance',
                                        'marketplace', 'distribution',
                                        'hotel_catalog', 'platform',
                                        'intelligence'
                                      )),
  source_view                TEXT        NOT NULL,
  primary_metric_definition_id UUID,
  read_only                  BOOLEAN     NOT NULL DEFAULT TRUE,
  required_resource_scope    TEXT        NOT NULL DEFAULT 'property'
                                      CHECK (required_resource_scope IN (
                                        'property', 'organization', 'platform'
                                      )),
  primary_required_permission_key TEXT    NOT NULL,
  required_permission_keys   TEXT[]      NOT NULL,
  supported_intents          TEXT[]      NOT NULL DEFAULT '{}',
  allowed_filters            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  freshness_slo_seconds      INTEGER     NOT NULL DEFAULT 86400
                                      CHECK (freshness_slo_seconds > 0),
  pii_policy                 TEXT        NOT NULL DEFAULT 'aggregate_only'
                                      CHECK (pii_policy IN (
                                        'none', 'aggregate_only',
                                        'minimized_pii', 'finance_restricted'
                                      )),
  unavailable_reasons        TEXT[]      NOT NULL DEFAULT ARRAY[
                                        'missing_scope',
                                        'not_linked_resource',
                                        'missing_permission',
                                        'source_unavailable',
                                        'stale_source',
                                        'empty_result'
                                      ]::TEXT[],
  evidence_contract          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status                     TEXT        NOT NULL DEFAULT 'active'
                                      CHECK (status IN ('active', 'deprecated', 'disabled')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_ai_evidence_catalog_tool
    UNIQUE (tool_id, tool_version),
  CONSTRAINT chk_intelligence_ai_evidence_catalog_tool_id
    CHECK (tool_id ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT chk_intelligence_ai_evidence_catalog_read_only
    CHECK (read_only = TRUE),
  CONSTRAINT chk_intelligence_ai_evidence_catalog_source_view
    CHECK (intelligence.valid_source_view(source_owner, source_view)),
  CONSTRAINT chk_intelligence_ai_evidence_catalog_permissions
    CHECK (
      cardinality(required_permission_keys) > 0
      AND primary_required_permission_key = ANY(required_permission_keys)
    ),
  CONSTRAINT chk_intelligence_ai_evidence_catalog_unavailable
    CHECK (
      unavailable_reasons <@ ARRAY[
        'missing_scope',
        'not_linked_resource',
        'missing_permission',
        'source_not_in_catalog',
        'source_unavailable',
        'stale_source',
        'empty_result',
        'external_data_needed',
        'pii_restricted'
      ]::TEXT[]
    ),
  CONSTRAINT chk_intelligence_ai_evidence_catalog_private_json
    CHECK (
      NOT intelligence.jsonb_has_forbidden_evidence_key(allowed_filters)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(evidence_contract)
    ),
  CONSTRAINT fk_intelligence_ai_evidence_catalog_metric
    FOREIGN KEY (primary_metric_definition_id)
    REFERENCES intelligence.metric_definitions(id),
  CONSTRAINT fk_intelligence_ai_evidence_catalog_permission
    FOREIGN KEY (primary_required_permission_key)
    REFERENCES identity.permission_catalog(key)
);

ALTER TABLE intelligence.ai_evidence_catalog
  ADD CONSTRAINT uq_intelligence_ai_evidence_catalog_tool_permission
  UNIQUE (tool_id, tool_version, primary_required_permission_key);

CREATE INDEX idx_intelligence_ai_evidence_catalog_active_product
  ON intelligence.ai_evidence_catalog (product, source_owner, tool_id)
  WHERE status = 'active';

CREATE TABLE intelligence.ask_conversations (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_key           TEXT        NOT NULL,
  actor_user_id              UUID        NOT NULL,
  organization_id            UUID,
  property_id                UUID,
  resource_link_id           UUID,
  resource_link_resource_id  TEXT        GENERATED ALWAYS AS (
                                      CASE
                                        WHEN property_id IS NULL THEN NULL
                                        ELSE property_id::TEXT
                                      END
                                    ) STORED,
  resource_scope             TEXT        NOT NULL DEFAULT 'property'
                                      CHECK (resource_scope IN (
                                        'property', 'organization', 'platform'
                                      )),
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                      intelligence.resource_scope_key(
                                        resource_scope,
                                        organization_id,
                                        property_id
                                      )
                                    ) STORED,
  conversation_state         TEXT        NOT NULL DEFAULT 'active'
                                      CHECK (conversation_state IN (
                                        'active', 'archived', 'expired', 'deleted'
                                      )),
  locale                     TEXT        NOT NULL DEFAULT 'en',
  title                      TEXT,
  retention_policy           TEXT        NOT NULL DEFAULT 'standard'
                                      CHECK (retention_policy IN (
                                        'standard', 'debug_hold',
                                        'short_lived', 'user_deleted'
                                      )),
  retention_expires_at       TIMESTAMPTZ,
  last_message_at            TIMESTAMPTZ,
  ended_at                   TIMESTAMPTZ,
  privacy_scope              TEXT        NOT NULL DEFAULT 'confidential'
                                      CHECK (privacy_scope IN (
                                        'internal', 'confidential', 'restricted'
                                      )),
  conversation_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_ask_conversations_key
    UNIQUE (conversation_key),
  CONSTRAINT uq_intelligence_ask_conversations_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT uq_intelligence_ask_conversations_id_actor_scope
    UNIQUE (id, actor_user_id, scope_key),
  CONSTRAINT chk_intelligence_ask_conversations_scope
    CHECK (intelligence.valid_resource_scope(resource_scope, organization_id, property_id)),
  CONSTRAINT chk_intelligence_ask_conversations_expiry
    CHECK (conversation_state <> 'expired' OR retention_expires_at IS NOT NULL),
  CONSTRAINT chk_intelligence_ask_conversations_retention
    CHECK (retention_policy <> 'short_lived' OR retention_expires_at IS NOT NULL),
  CONSTRAINT chk_intelligence_ask_conversations_visibility
    CHECK (privacy_scope IN ('internal', 'confidential', 'restricted')),
  CONSTRAINT chk_intelligence_ask_conversations_resource_link_scope
    CHECK (
      resource_link_id IS NULL
      OR (
        resource_scope = 'property'
        AND organization_id IS NOT NULL
        AND property_id IS NOT NULL
      )
    ),
  CONSTRAINT chk_intelligence_ask_conversations_private_json
    CHECK (NOT intelligence.jsonb_has_forbidden_evidence_key(conversation_metadata)),
  CONSTRAINT fk_intelligence_ask_conversations_actor
    FOREIGN KEY (actor_user_id)
    REFERENCES identity.users(id),
  CONSTRAINT fk_intelligence_ask_conversations_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_intelligence_ask_conversations_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_intelligence_ask_conversations_resource_link
    FOREIGN KEY (resource_link_id, organization_id, resource_link_resource_id)
    REFERENCES identity.organization_resource_links(id, organization_id, resource_id)
);

CREATE INDEX idx_intelligence_ask_conversations_actor
  ON intelligence.ask_conversations (actor_user_id, updated_at DESC);

CREATE TABLE intelligence.ask_runs (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key                    TEXT        NOT NULL,
  conversation_id            UUID        NOT NULL,
  actor_user_id              UUID        NOT NULL,
  organization_id            UUID,
  property_id                UUID,
  resource_scope             TEXT        NOT NULL DEFAULT 'property'
                                      CHECK (resource_scope IN (
                                        'property', 'organization', 'platform'
                                      )),
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                      intelligence.resource_scope_key(
                                        resource_scope,
                                        organization_id,
                                        property_id
                                      )
                                    ) STORED,
  request_id                 TEXT        NOT NULL,
  correlation_id             TEXT,
  idempotency_key_id         UUID,
  question_redacted_text     TEXT        NOT NULL,
  question_hash              TEXT        NOT NULL,
  detected_intent            TEXT,
  required_permission_key    TEXT        NOT NULL DEFAULT 'intelligence.ask.read',
  run_status                 TEXT        NOT NULL DEFAULT 'running'
                                      CHECK (run_status IN (
                                        'planned', 'running', 'answered',
                                        'partial', 'needs_clarification',
                                        'unavailable', 'external_data_needed',
                                        'not_authorized', 'failed', 'canceled'
                                      )),
  confidence_level           TEXT        NOT NULL DEFAULT 'unknown'
                                      CHECK (confidence_level IN (
                                        'high', 'medium', 'low', 'unknown'
                                      )),
  model_provider             TEXT,
  model_name                 TEXT,
  prompt_version             TEXT        NOT NULL,
  schema_version             TEXT        NOT NULL DEFAULT 'ask-answer.v1',
  tool_plan                  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  unavailable_data           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  caveats                    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  token_usage                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  cost_metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at                TIMESTAMPTZ,
  latency_ms                 INTEGER     CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_ask_runs_key
    UNIQUE (run_key),
  CONSTRAINT uq_intelligence_ask_runs_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT uq_intelligence_ask_runs_id_conversation_scope
    UNIQUE (id, conversation_id, scope_key),
  CONSTRAINT chk_intelligence_ask_runs_scope
    CHECK (intelligence.valid_resource_scope(resource_scope, organization_id, property_id)),
  CONSTRAINT chk_intelligence_ask_runs_question_redacted
    CHECK (NOT intelligence.text_has_forbidden_evidence_value(question_redacted_text)),
  CONSTRAINT chk_intelligence_ask_runs_terminal_time
    CHECK (
      run_status NOT IN (
        'answered', 'partial', 'needs_clarification', 'unavailable',
        'external_data_needed', 'not_authorized', 'failed', 'canceled'
      )
      OR finished_at IS NOT NULL
    ),
  CONSTRAINT chk_intelligence_ask_runs_answer_evidence
    CHECK (
      run_status NOT IN ('answered', 'partial')
      OR jsonb_array_length(tool_plan) > 0
    ),
  CONSTRAINT chk_intelligence_ask_runs_private_json
    CHECK (
      NOT intelligence.jsonb_has_forbidden_evidence_key(tool_plan)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(unavailable_data)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(caveats)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(token_usage)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(cost_metadata)
    ),
  CONSTRAINT fk_intelligence_ask_runs_conversation_scope
    FOREIGN KEY (conversation_id, scope_key)
    REFERENCES intelligence.ask_conversations(id, scope_key),
  CONSTRAINT fk_intelligence_ask_runs_conversation_actor_scope
    FOREIGN KEY (conversation_id, actor_user_id, scope_key)
    REFERENCES intelligence.ask_conversations(id, actor_user_id, scope_key),
  CONSTRAINT fk_intelligence_ask_runs_actor
    FOREIGN KEY (actor_user_id)
    REFERENCES identity.users(id),
  CONSTRAINT fk_intelligence_ask_runs_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_intelligence_ask_runs_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_intelligence_ask_runs_permission
    FOREIGN KEY (required_permission_key)
    REFERENCES identity.permission_catalog(key),
  CONSTRAINT fk_intelligence_ask_runs_idempotency_key
    FOREIGN KEY (idempotency_key_id)
    REFERENCES platform.idempotency_keys(id)
);

CREATE INDEX idx_intelligence_ask_runs_conversation
  ON intelligence.ask_runs (conversation_id, started_at DESC);

CREATE TABLE intelligence.ask_tool_calls (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                     UUID        NOT NULL,
  tool_id                    TEXT        NOT NULL,
  tool_version               TEXT        NOT NULL DEFAULT 'v1',
  call_sequence              INTEGER     NOT NULL CHECK (call_sequence >= 1),
  resource_scope             TEXT        NOT NULL DEFAULT 'property'
                                      CHECK (resource_scope IN (
                                        'property', 'organization', 'platform'
                                      )),
  organization_id            UUID,
  property_id                UUID,
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                      intelligence.resource_scope_key(
                                        resource_scope,
                                        organization_id,
                                        property_id
                                      )
                                    ) STORED,
  required_permission_key    TEXT        NOT NULL,
  authorization_status       TEXT        NOT NULL DEFAULT 'allowed'
                                      CHECK (authorization_status IN (
                                        'allowed', 'denied',
                                        'not_required', 'error'
                                      )),
  result_status              TEXT        NOT NULL
                                      CHECK (result_status IN (
                                        'available', 'partial',
                                        'unavailable', 'not_authorized',
                                        'invalid_scope', 'error', 'skipped'
                                      )),
  input_scope                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  filters                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  evidence_references        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  unavailable_data           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  result_summary             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_code                 TEXT,
  error_summary              TEXT,
  latency_ms                 INTEGER     CHECK (latency_ms IS NULL OR latency_ms >= 0),
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at                TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_ask_tool_calls_run_sequence
    UNIQUE (run_id, call_sequence),
  CONSTRAINT chk_intelligence_ask_tool_calls_scope
    CHECK (intelligence.valid_resource_scope(resource_scope, organization_id, property_id)),
  CONSTRAINT chk_intelligence_ask_tool_calls_available_evidence
    CHECK (
      result_status <> 'available'
      OR jsonb_array_length(evidence_references) > 0
    ),
  CONSTRAINT chk_intelligence_ask_tool_calls_authorization
    CHECK (
      (result_status = 'not_authorized' AND authorization_status = 'denied')
      OR
      (result_status <> 'not_authorized' AND authorization_status <> 'denied')
    ),
  CONSTRAINT chk_intelligence_ask_tool_calls_time
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT chk_intelligence_ask_tool_calls_private_json
    CHECK (
      NOT intelligence.jsonb_has_forbidden_evidence_key(input_scope)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(filters)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(evidence_references)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(unavailable_data)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(result_summary)
    ),
  CONSTRAINT fk_intelligence_ask_tool_calls_run_scope
    FOREIGN KEY (run_id, scope_key)
    REFERENCES intelligence.ask_runs(id, scope_key),
  CONSTRAINT fk_intelligence_ask_tool_calls_tool
    FOREIGN KEY (tool_id, tool_version)
    REFERENCES intelligence.ai_evidence_catalog(tool_id, tool_version),
  CONSTRAINT fk_intelligence_ask_tool_calls_tool_permission
    FOREIGN KEY (tool_id, tool_version, required_permission_key)
    REFERENCES intelligence.ai_evidence_catalog(
      tool_id,
      tool_version,
      primary_required_permission_key
    ),
  CONSTRAINT fk_intelligence_ask_tool_calls_permission
    FOREIGN KEY (required_permission_key)
    REFERENCES identity.permission_catalog(key),
  CONSTRAINT fk_intelligence_ask_tool_calls_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_intelligence_ask_tool_calls_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
);

CREATE INDEX idx_intelligence_ask_tool_calls_run
  ON intelligence.ask_tool_calls (run_id, call_sequence);

CREATE TABLE intelligence.ask_answer_audits (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_id                  TEXT        NOT NULL,
  run_id                     UUID        NOT NULL,
  conversation_id            UUID        NOT NULL,
  platform_audit_event_id    UUID,
  organization_id            UUID,
  property_id                UUID,
  resource_scope             TEXT        NOT NULL DEFAULT 'property'
                                      CHECK (resource_scope IN (
                                        'property', 'organization', 'platform'
                                      )),
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                      intelligence.resource_scope_key(
                                        resource_scope,
                                        organization_id,
                                        property_id
                                      )
                                    ) STORED,
  contract_version           TEXT        NOT NULL DEFAULT 'ask-answer.v1',
  answer_status              TEXT        NOT NULL
                                      CHECK (answer_status IN (
                                        'answered', 'partial',
                                        'needs_clarification', 'unavailable',
                                        'external_data_needed',
                                        'not_authorized'
                                      )),
  confidence_level           TEXT        NOT NULL DEFAULT 'unknown'
                                      CHECK (confidence_level IN (
                                        'high', 'medium', 'low', 'unknown'
                                      )),
  question_hash              TEXT        NOT NULL,
  audit_revision             INTEGER     NOT NULL DEFAULT 1,
  summary                    TEXT,
  generated_answer           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  evidence_references        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  material_claims            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  suggested_actions          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  unavailable_data           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  caveats                    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  review_status              TEXT        NOT NULL DEFAULT 'not_reviewed'
                                      CHECK (review_status IN (
                                        'not_reviewed', 'needs_review',
                                        'approved', 'rejected'
                                      )),
  reviewed_by_user_id        UUID,
  reviewed_at                TIMESTAMPTZ,
  retention_class            TEXT        NOT NULL DEFAULT 'standard'
                                      CHECK (retention_class IN (
                                        'standard', 'debug_hold',
                                        'guest_pii_excluded',
                                        'finance_restricted'
                                      )),
  privacy_scope              TEXT        NOT NULL DEFAULT 'confidential'
                                      CHECK (privacy_scope IN (
                                        'internal', 'confidential', 'restricted'
                                      )),
  audit_metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_intelligence_ask_answer_audits_answer
    UNIQUE (answer_id),
  CONSTRAINT uq_intelligence_ask_answer_audits_run_revision
    UNIQUE (run_id, audit_revision),
  CONSTRAINT chk_intelligence_ask_answer_audits_scope
    CHECK (intelligence.valid_resource_scope(resource_scope, organization_id, property_id)),
  CONSTRAINT chk_intelligence_ask_answer_audits_revision
    CHECK (audit_revision >= 1),
  CONSTRAINT chk_intelligence_ask_answer_audits_visibility
    CHECK (privacy_scope IN ('internal', 'confidential', 'restricted')),
  CONSTRAINT chk_intelligence_ask_answer_audits_retention
    CHECK (retention_class <> 'finance_restricted' OR privacy_scope = 'restricted'),
  CONSTRAINT chk_intelligence_ask_answer_audits_claim_support
    CHECK (
      jsonb_array_length(material_claims) = 0
      OR
      jsonb_array_length(evidence_references) > 0
      OR
      jsonb_array_length(unavailable_data) > 0
    ),
  CONSTRAINT chk_intelligence_ask_answer_audits_status_support
    CHECK (
      answer_status NOT IN ('answered', 'partial')
      OR jsonb_array_length(evidence_references) > 0
    ),
  CONSTRAINT chk_intelligence_ask_answer_audits_review
    CHECK (
      review_status IN ('not_reviewed', 'needs_review')
      OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
  CONSTRAINT chk_intelligence_ask_answer_audits_private_json
    CHECK (
      NOT intelligence.jsonb_has_forbidden_evidence_key(generated_answer)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(evidence_references)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(material_claims)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(suggested_actions)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(unavailable_data)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(caveats)
      AND NOT intelligence.jsonb_has_forbidden_evidence_key(audit_metadata)
    ),
  CONSTRAINT fk_intelligence_ask_answer_audits_run_scope
    FOREIGN KEY (run_id, scope_key)
    REFERENCES intelligence.ask_runs(id, scope_key),
  CONSTRAINT fk_intelligence_ask_answer_audits_run_conversation_scope
    FOREIGN KEY (run_id, conversation_id, scope_key)
    REFERENCES intelligence.ask_runs(id, conversation_id, scope_key),
  CONSTRAINT fk_intelligence_ask_answer_audits_conversation_scope
    FOREIGN KEY (conversation_id, scope_key)
    REFERENCES intelligence.ask_conversations(id, scope_key),
  CONSTRAINT fk_intelligence_ask_answer_audits_platform_audit
    FOREIGN KEY (platform_audit_event_id)
    REFERENCES platform.product_audit_events(id),
  CONSTRAINT fk_intelligence_ask_answer_audits_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_intelligence_ask_answer_audits_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_intelligence_ask_answer_audits_reviewer
    FOREIGN KEY (reviewed_by_user_id)
    REFERENCES identity.users(id)
);

CREATE INDEX idx_intelligence_ask_answer_audits_property
  ON intelligence.ask_answer_audits (property_id, created_at DESC)
  WHERE property_id IS NOT NULL;

CREATE TRIGGER trg_intelligence_ask_answer_audits_append_only
  BEFORE UPDATE OR DELETE ON intelligence.ask_answer_audits
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_append_only_mutation();
