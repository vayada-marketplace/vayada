-- Migration: 0010_platform_jobs_events_audit
-- Owner: platform-events-audit
-- See: engineering/target-schema-migration-coverage.md,
--      engineering/target-schema-ownership-map.md,
--      engineering/migration-parity-harness.md
--
-- Creates the platform jobs/events/audit target schema for durable domain
-- events, transactional outbox rows, job retry state, idempotency records,
-- raw external webhook receipts, dead-letter records, and product audit events.
--
-- Legacy product databases are migration/parity inputs only. Runtime
-- TypeScript code must not use this migration as a reason to read legacy
-- product databases directly.

CREATE SCHEMA IF NOT EXISTS platform;

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_schema_migrations_applied_version
  ON platform.schema_migrations (version)
  WHERE status = 'applied';

CREATE INDEX IF NOT EXISTS idx_platform_schema_migrations_environment_version
  ON platform.schema_migrations (environment, version, applied_at DESC);

CREATE FUNCTION platform.tenant_scope_key(
  tenant_scope TEXT,
  organization_id UUID,
  property_id UUID
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN tenant_scope = 'platform' THEN 'platform'
    WHEN tenant_scope = 'organization' THEN 'organization:' || organization_id::TEXT
    WHEN tenant_scope = 'property' THEN 'property:' || property_id::TEXT
    WHEN tenant_scope = 'external' THEN 'external'
    WHEN tenant_scope = 'migration' THEN 'migration'
  END;
$$;

CREATE FUNCTION platform.valid_tenant_scope(
  tenant_scope TEXT,
  organization_id UUID,
  property_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN tenant_scope = 'platform' THEN organization_id IS NULL AND property_id IS NULL
    WHEN tenant_scope = 'organization' THEN organization_id IS NOT NULL AND property_id IS NULL
    WHEN tenant_scope = 'property' THEN organization_id IS NULL AND property_id IS NOT NULL
    WHEN tenant_scope IN ('external', 'migration') THEN organization_id IS NULL AND property_id IS NULL
    ELSE FALSE
  END;
$$;

CREATE FUNCTION platform.prevent_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform append-only table % cannot be %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TABLE platform.domain_events (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system      TEXT        NOT NULL
                                CHECK (source_system IN (
                                  'identity', 'hotel_catalog', 'booking', 'pms',
                                  'finance', 'marketplace', 'distribution',
                                  'platform', 'external', 'migration'
                                )),
  event_key          TEXT        NOT NULL,
  event_type         TEXT        NOT NULL,
  event_version      INTEGER     NOT NULL DEFAULT 1,
  occurred_at        TIMESTAMPTZ NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_status       TEXT        NOT NULL DEFAULT 'recorded'
                                CHECK (event_status IN (
                                  'recorded', 'projected', 'ignored',
                                  'dead_lettered', 'superseded'
                                )),
  tenant_scope       TEXT        NOT NULL
                                CHECK (tenant_scope IN (
                                  'platform', 'organization', 'property',
                                  'external', 'migration'
                                )),
  organization_id    UUID,
  property_id        UUID,
  scope_key          TEXT        GENERATED ALWAYS AS (
                                platform.tenant_scope_key(
                                  tenant_scope,
                                  organization_id,
                                  property_id
                                )
                              ) STORED,
  resource_product   TEXT        NOT NULL
                                CHECK (resource_product IN (
                                  'identity', 'hotel_catalog', 'booking', 'pms',
                                  'finance', 'marketplace', 'distribution',
                                  'platform', 'intelligence'
                                )),
  resource_type      TEXT        NOT NULL,
  resource_id        TEXT        NOT NULL,
  actor_type         TEXT        NOT NULL DEFAULT 'system'
                                CHECK (actor_type IN (
                                  'user', 'system', 'provider', 'migration'
                                )),
  actor_user_id      UUID,
  correlation_id     TEXT,
  causation_id       TEXT,
  idempotency_key_hash TEXT,
  payload            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  event_metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  privacy_scope      TEXT        NOT NULL DEFAULT 'internal'
                                CHECK (privacy_scope IN (
                                  'internal', 'confidential', 'restricted'
                                )),
  ai_visible         BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_platform_domain_events_source_event_key
    UNIQUE (source_system, event_key),
  CONSTRAINT uq_platform_domain_events_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_platform_domain_events_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT chk_platform_domain_events_version
    CHECK (event_version >= 1),
  CONSTRAINT chk_platform_domain_events_scope
    CHECK (platform.valid_tenant_scope(tenant_scope, organization_id, property_id)),
  CONSTRAINT chk_platform_domain_events_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_domain_events_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_domain_events_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_platform_domain_events_actor
    FOREIGN KEY (actor_user_id)
    REFERENCES identity.users(id)
);

CREATE INDEX idx_platform_domain_events_resource
  ON platform.domain_events (resource_product, resource_type, resource_id, occurred_at DESC);

CREATE INDEX idx_platform_domain_events_property_time
  ON platform.domain_events (property_id, occurred_at DESC)
  WHERE property_id IS NOT NULL;

CREATE INDEX idx_platform_domain_events_correlation
  ON platform.domain_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE platform.external_webhook_events (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                   TEXT        NOT NULL
                                          CHECK (provider IN (
                                            'workos', 'channex', 'stripe',
                                            'xendit', 'sendgrid', 'mailgun',
                                            'lodgify', 'beds24', 'other'
                                          )),
  provider_event_id          TEXT,
  webhook_key_hash           TEXT,
  event_type                 TEXT        NOT NULL,
  delivery_status            TEXT        NOT NULL DEFAULT 'received'
                                          CHECK (delivery_status IN (
                                            'received', 'validated', 'normalized',
                                            'ignored', 'failed', 'dead_lettered'
                                          )),
  signature_verified         BOOLEAN     NOT NULL DEFAULT FALSE,
  received_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at               TIMESTAMPTZ,
  tenant_scope               TEXT        NOT NULL DEFAULT 'external'
                                          CHECK (tenant_scope IN (
                                            'platform', 'organization', 'property',
                                            'external', 'migration'
                                          )),
  organization_id            UUID,
  property_id                UUID,
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                            platform.tenant_scope_key(
                                              tenant_scope,
                                              organization_id,
                                              property_id
                                            )
                                          ) STORED,
  normalized_domain_event_id UUID,
  correlation_id             TEXT,
  payload_hash               TEXT        NOT NULL,
  raw_headers                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  raw_payload                JSONB       NOT NULL,
  failure_reason             TEXT,
  privacy_scope              TEXT        NOT NULL DEFAULT 'restricted'
                                          CHECK (privacy_scope IN ('confidential', 'restricted')),
  ai_visible                 BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_platform_external_webhook_events_provider_event
    UNIQUE (provider, provider_event_id),
  CONSTRAINT uq_platform_external_webhook_events_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT chk_platform_external_webhook_events_dedupe_key
    CHECK (provider_event_id IS NOT NULL OR webhook_key_hash IS NOT NULL),
  CONSTRAINT chk_platform_external_webhook_events_processing
    CHECK (delivery_status <> 'normalized' OR normalized_domain_event_id IS NOT NULL),
  CONSTRAINT chk_platform_external_webhook_events_scope
    CHECK (platform.valid_tenant_scope(tenant_scope, organization_id, property_id)),
  CONSTRAINT chk_platform_external_webhook_events_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_external_webhook_events_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_external_webhook_events_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_platform_external_webhook_events_domain_event
    FOREIGN KEY (normalized_domain_event_id)
    REFERENCES platform.domain_events(id),
  CONSTRAINT fk_platform_external_webhook_events_domain_event_property
    FOREIGN KEY (normalized_domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_platform_external_webhook_events_domain_event_scope
    FOREIGN KEY (normalized_domain_event_id, scope_key)
    REFERENCES platform.domain_events(id, scope_key)
);

CREATE INDEX idx_platform_external_webhook_events_provider_time
  ON platform.external_webhook_events (provider, received_at DESC);

CREATE UNIQUE INDEX uq_platform_external_webhook_events_webhook_key_hash
  ON platform.external_webhook_events (provider, webhook_key_hash)
  WHERE webhook_key_hash IS NOT NULL;

CREATE INDEX idx_platform_external_webhook_events_property_time
  ON platform.external_webhook_events (property_id, received_at DESC)
  WHERE property_id IS NOT NULL;

CREATE TABLE platform.outbox_events (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_event_id    UUID        NOT NULL,
  outbox_key         TEXT        NOT NULL,
  destination        TEXT        NOT NULL,
  event_type         TEXT        NOT NULL,
  tenant_scope       TEXT        NOT NULL DEFAULT 'platform'
                                CHECK (tenant_scope IN (
                                  'platform', 'organization', 'property',
                                  'external', 'migration'
                                )),
  organization_id    UUID,
  property_id        UUID,
  scope_key          TEXT        GENERATED ALWAYS AS (
                                platform.tenant_scope_key(
                                  tenant_scope,
                                  organization_id,
                                  property_id
                                )
                              ) STORED,
  resource_product   TEXT        NOT NULL DEFAULT 'platform'
                                CHECK (resource_product IN (
                                  'identity', 'hotel_catalog', 'booking', 'pms',
                                  'finance', 'marketplace', 'distribution',
                                  'platform', 'intelligence'
                                )),
  resource_type      TEXT        NOT NULL DEFAULT 'outbox_event',
  resource_id        TEXT        NOT NULL DEFAULT '',
  status             TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN (
                                  'pending', 'leased', 'published',
                                  'failed', 'canceled'
                                )),
  priority           INTEGER     NOT NULL DEFAULT 0 CHECK (priority >= 0),
  attempts_count     INTEGER     NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
  max_attempts       INTEGER     NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  available_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_until       TIMESTAMPTZ,
  published_at       TIMESTAMPTZ,
  correlation_id     TEXT,
  idempotency_key_hash TEXT,
  payload            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  outbox_metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ai_visible         BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_platform_outbox_events_key
    UNIQUE (destination, outbox_key),
  CONSTRAINT uq_platform_outbox_events_id_domain_event
    UNIQUE (id, domain_event_id),
  CONSTRAINT uq_platform_outbox_events_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT chk_platform_outbox_events_attempts
    CHECK (attempts_count <= max_attempts),
  CONSTRAINT chk_platform_outbox_events_scope
    CHECK (platform.valid_tenant_scope(tenant_scope, organization_id, property_id)),
  CONSTRAINT chk_platform_outbox_events_lease_state
    CHECK (status <> 'leased' OR leased_until IS NOT NULL),
  CONSTRAINT chk_platform_outbox_events_publish_state
    CHECK (
      (status = 'published' AND published_at IS NOT NULL)
      OR
      (status <> 'published' AND published_at IS NULL)
    ),
  CONSTRAINT chk_platform_outbox_events_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_outbox_events_domain_event
    FOREIGN KEY (domain_event_id)
    REFERENCES platform.domain_events(id),
  CONSTRAINT fk_platform_outbox_events_domain_event_scope
    FOREIGN KEY (domain_event_id, scope_key)
    REFERENCES platform.domain_events(id, scope_key),
  CONSTRAINT fk_platform_outbox_events_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_outbox_events_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
);

CREATE INDEX idx_platform_outbox_events_status_available
  ON platform.outbox_events (status, available_at, priority DESC);

CREATE TABLE platform.jobs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key               TEXT        NOT NULL,
  queue_name            TEXT        NOT NULL,
  job_type              TEXT        NOT NULL,
  source_domain_event_id UUID,
  source_outbox_event_id UUID,
  status                TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN (
                                      'pending', 'running', 'succeeded',
                                      'failed', 'canceled', 'dead_lettered'
                                    )),
  priority              INTEGER     NOT NULL DEFAULT 0 CHECK (priority >= 0),
  attempts_count        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
  max_attempts          INTEGER     NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_after             TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at             TIMESTAMPTZ,
  locked_by             TEXT,
  finished_at           TIMESTAMPTZ,
  tenant_scope          TEXT        NOT NULL DEFAULT 'platform'
                                    CHECK (tenant_scope IN (
                                      'platform', 'organization', 'property',
                                      'external', 'migration'
                                    )),
  organization_id       UUID,
  property_id           UUID,
  scope_key             TEXT        GENERATED ALWAYS AS (
                                       platform.tenant_scope_key(
                                         tenant_scope,
                                         organization_id,
                                         property_id
                                       )
                                     ) STORED,
  resource_product      TEXT        NOT NULL DEFAULT 'platform'
                                    CHECK (resource_product IN (
                                      'identity', 'hotel_catalog', 'booking', 'pms',
                                      'finance', 'marketplace', 'distribution',
                                      'platform', 'intelligence'
                                    )),
  resource_type         TEXT        NOT NULL DEFAULT 'platform_job',
  resource_id           TEXT        NOT NULL DEFAULT '',
  correlation_id        TEXT,
  idempotency_key_hash  TEXT,
  payload               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  job_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ai_visible            BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_platform_jobs_key
    UNIQUE (queue_name, job_key),
  CONSTRAINT uq_platform_jobs_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT chk_platform_jobs_attempts
    CHECK (attempts_count <= max_attempts),
  CONSTRAINT chk_platform_jobs_running_lock
    CHECK (status <> 'running' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CONSTRAINT chk_platform_jobs_terminal_time
    CHECK (
      status NOT IN ('succeeded', 'failed', 'canceled', 'dead_lettered')
      OR finished_at IS NOT NULL
    ),
  CONSTRAINT chk_platform_jobs_source_pair
    CHECK (source_outbox_event_id IS NULL OR source_domain_event_id IS NOT NULL),
  CONSTRAINT chk_platform_jobs_scope
    CHECK (platform.valid_tenant_scope(tenant_scope, organization_id, property_id)),
  CONSTRAINT chk_platform_jobs_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_jobs_domain_event
    FOREIGN KEY (source_domain_event_id)
    REFERENCES platform.domain_events(id),
  CONSTRAINT fk_platform_jobs_domain_event_scope
    FOREIGN KEY (source_domain_event_id, scope_key)
    REFERENCES platform.domain_events(id, scope_key),
  CONSTRAINT fk_platform_jobs_outbox_event
    FOREIGN KEY (source_outbox_event_id)
    REFERENCES platform.outbox_events(id),
  CONSTRAINT fk_platform_jobs_outbox_event_scope
    FOREIGN KEY (source_outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key),
  CONSTRAINT fk_platform_jobs_outbox_domain_event
    FOREIGN KEY (source_outbox_event_id, source_domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_platform_jobs_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_jobs_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
);

CREATE INDEX idx_platform_jobs_status_run_after
  ON platform.jobs (status, run_after, priority DESC);

CREATE INDEX idx_platform_jobs_resource
  ON platform.jobs (resource_product, resource_type, resource_id);

CREATE TABLE platform.job_attempts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID        NOT NULL,
  attempt_number    INTEGER     NOT NULL CHECK (attempt_number >= 1),
  status            TEXT        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out', 'canceled')),
  worker_id         TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  duration_ms       INTEGER     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_type        TEXT,
  error_message     TEXT,
  error_metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  retry_after       TIMESTAMPTZ,
  ai_visible        BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_platform_job_attempts_job_number
    UNIQUE (job_id, attempt_number),
  CONSTRAINT uq_platform_job_attempts_id_job
    UNIQUE (id, job_id),
  CONSTRAINT chk_platform_job_attempts_time
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT chk_platform_job_attempts_terminal_time
    CHECK (
      status NOT IN ('succeeded', 'failed', 'timed_out', 'canceled')
      OR finished_at IS NOT NULL
    ),
  CONSTRAINT chk_platform_job_attempts_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_job_attempts_job
    FOREIGN KEY (job_id)
    REFERENCES platform.jobs(id)
);

CREATE INDEX idx_platform_job_attempts_job
  ON platform.job_attempts (job_id, attempt_number);

CREATE TABLE platform.idempotency_keys (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_scope            TEXT        NOT NULL
                                         CHECK (operation_scope IN (
                                           'identity', 'hotel_catalog', 'booking',
                                           'pms', 'finance', 'marketplace',
                                           'distribution', 'platform', 'intelligence'
                                         )),
  operation                  TEXT        NOT NULL,
  key_hash                   TEXT        NOT NULL,
  request_fingerprint_hash   TEXT        NOT NULL,
  status                     TEXT        NOT NULL DEFAULT 'in_progress'
                                         CHECK (status IN (
                                           'in_progress', 'completed', 'failed',
                                           'expired', 'conflict'
                                         )),
  tenant_scope               TEXT        NOT NULL DEFAULT 'platform'
                                         CHECK (tenant_scope IN (
                                           'platform', 'organization', 'property',
                                           'external', 'migration'
                                         )),
  organization_id            UUID,
  property_id                UUID,
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                            platform.tenant_scope_key(
                                              tenant_scope,
                                              organization_id,
                                              property_id
                                            )
                                          ) STORED,
  response_status_code       INTEGER     CHECK (
                                           response_status_code IS NULL
                                           OR response_status_code BETWEEN 100 AND 599
                                         ),
  response_body_hash         TEXT,
  response_resource_product  TEXT,
  response_resource_type     TEXT,
  response_resource_id       TEXT,
  correlation_id             TEXT,
  first_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until               TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ,
  expires_at                 TIMESTAMPTZ NOT NULL,
  idempotency_metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ai_visible                 BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_platform_idempotency_keys_id_scope
    UNIQUE (id, scope_key),
  CONSTRAINT chk_platform_idempotency_keys_scope
    CHECK (platform.valid_tenant_scope(tenant_scope, organization_id, property_id)),
  CONSTRAINT chk_platform_idempotency_keys_completion
    CHECK (
      status <> 'completed'
      OR (
        completed_at IS NOT NULL
        AND response_status_code IS NOT NULL
        AND (
          response_body_hash IS NOT NULL
          OR (
            response_resource_product IS NOT NULL
            AND response_resource_type IS NOT NULL
            AND response_resource_id IS NOT NULL
          )
        )
      )
    ),
  CONSTRAINT chk_platform_idempotency_keys_response_resource
    CHECK (
      (
        response_resource_product IS NULL
        AND response_resource_type IS NULL
        AND response_resource_id IS NULL
      )
      OR
      (
        response_resource_product IS NOT NULL
        AND response_resource_type IS NOT NULL
        AND response_resource_id IS NOT NULL
      )
    ),
  CONSTRAINT chk_platform_idempotency_keys_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_idempotency_keys_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_idempotency_keys_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
);

CREATE INDEX idx_platform_idempotency_keys_expiry
  ON platform.idempotency_keys (expires_at, status);

CREATE UNIQUE INDEX uq_platform_idempotency_keys_operation_scope_hash
  ON platform.idempotency_keys (operation_scope, operation, key_hash, scope_key);

CREATE TABLE platform.dead_letter_events (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind           TEXT        NOT NULL
                                      CHECK (source_kind IN (
                                        'domain_event', 'outbox_event',
                                        'job', 'webhook'
                                      )),
  domain_event_id       UUID,
  outbox_event_id       UUID,
  job_id                UUID,
  job_attempt_id        UUID,
  webhook_event_id      UUID,
  requeued_job_id       UUID,
  tenant_scope          TEXT        NOT NULL DEFAULT 'platform'
                                      CHECK (tenant_scope IN (
                                        'platform', 'organization', 'property',
                                        'external', 'migration'
                                      )),
  organization_id       UUID,
  property_id           UUID,
  scope_key             TEXT        GENERATED ALWAYS AS (
                                      platform.tenant_scope_key(
                                        tenant_scope,
                                        organization_id,
                                        property_id
                                      )
                                    ) STORED,
  resource_product      TEXT        NOT NULL DEFAULT 'platform'
                                      CHECK (resource_product IN (
                                        'identity', 'hotel_catalog', 'booking', 'pms',
                                        'finance', 'marketplace', 'distribution',
                                        'platform', 'intelligence'
                                      )),
  resource_type         TEXT        NOT NULL DEFAULT 'dead_letter_event',
  resource_id           TEXT        NOT NULL DEFAULT '',
  correlation_id        TEXT,
  idempotency_key_hash  TEXT,
  reason_code           TEXT        NOT NULL,
  failure_summary       TEXT        NOT NULL,
  failure_payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  recovery_status       TEXT        NOT NULL DEFAULT 'open'
                                      CHECK (recovery_status IN (
                                        'open', 'acknowledged',
                                        'requeued', 'resolved'
                                      )),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at       TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  ai_visible            BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT chk_platform_dead_letter_events_source
    CHECK (
      (
        source_kind = 'domain_event'
        AND domain_event_id IS NOT NULL
        AND outbox_event_id IS NULL
        AND job_id IS NULL
        AND job_attempt_id IS NULL
        AND webhook_event_id IS NULL
      )
      OR
      (
        source_kind = 'outbox_event'
        AND outbox_event_id IS NOT NULL
        AND domain_event_id IS NULL
        AND job_id IS NULL
        AND job_attempt_id IS NULL
        AND webhook_event_id IS NULL
      )
      OR
      (
        source_kind = 'job'
        AND job_id IS NOT NULL
        AND domain_event_id IS NULL
        AND outbox_event_id IS NULL
        AND webhook_event_id IS NULL
      )
      OR
      (
        source_kind = 'webhook'
        AND webhook_event_id IS NOT NULL
        AND domain_event_id IS NULL
        AND outbox_event_id IS NULL
        AND job_id IS NULL
        AND job_attempt_id IS NULL
      )
    ),
  CONSTRAINT chk_platform_dead_letter_events_scope
    CHECK (platform.valid_tenant_scope(tenant_scope, organization_id, property_id)),
  CONSTRAINT chk_platform_dead_letter_events_resolution
    CHECK (recovery_status <> 'resolved' OR resolved_at IS NOT NULL),
  CONSTRAINT chk_platform_dead_letter_events_requeue
    CHECK (recovery_status <> 'requeued' OR requeued_job_id IS NOT NULL),
  CONSTRAINT chk_platform_dead_letter_events_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_dead_letter_events_domain_event
    FOREIGN KEY (domain_event_id)
    REFERENCES platform.domain_events(id),
  CONSTRAINT fk_platform_dead_letter_events_domain_event_scope
    FOREIGN KEY (domain_event_id, scope_key)
    REFERENCES platform.domain_events(id, scope_key),
  CONSTRAINT fk_platform_dead_letter_events_outbox_event
    FOREIGN KEY (outbox_event_id)
    REFERENCES platform.outbox_events(id),
  CONSTRAINT fk_platform_dead_letter_events_outbox_event_scope
    FOREIGN KEY (outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key),
  CONSTRAINT fk_platform_dead_letter_events_job
    FOREIGN KEY (job_id)
    REFERENCES platform.jobs(id),
  CONSTRAINT fk_platform_dead_letter_events_job_scope
    FOREIGN KEY (job_id, scope_key)
    REFERENCES platform.jobs(id, scope_key),
  CONSTRAINT fk_platform_dead_letter_events_job_attempt
    FOREIGN KEY (job_attempt_id, job_id)
    REFERENCES platform.job_attempts(id, job_id),
  CONSTRAINT fk_platform_dead_letter_events_webhook_event
    FOREIGN KEY (webhook_event_id)
    REFERENCES platform.external_webhook_events(id),
  CONSTRAINT fk_platform_dead_letter_events_webhook_event_scope
    FOREIGN KEY (webhook_event_id, scope_key)
    REFERENCES platform.external_webhook_events(id, scope_key),
  CONSTRAINT fk_platform_dead_letter_events_requeued_job
    FOREIGN KEY (requeued_job_id)
    REFERENCES platform.jobs(id),
  CONSTRAINT fk_platform_dead_letter_events_requeued_job_scope
    FOREIGN KEY (requeued_job_id, scope_key)
    REFERENCES platform.jobs(id, scope_key),
  CONSTRAINT fk_platform_dead_letter_events_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_dead_letter_events_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
);

CREATE INDEX idx_platform_dead_letter_events_status
  ON platform.dead_letter_events (recovery_status, created_at DESC);

CREATE TABLE platform.product_audit_events (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_key                  TEXT        NOT NULL,
  product                    TEXT        NOT NULL
                                         CHECK (product IN (
                                           'identity', 'hotel_catalog', 'booking',
                                           'pms', 'finance', 'marketplace',
                                           'distribution', 'platform', 'intelligence'
                                         )),
  action                     TEXT        NOT NULL,
  action_version             INTEGER     NOT NULL DEFAULT 1 CHECK (action_version >= 1),
  occurred_at                TIMESTAMPTZ NOT NULL,
  recorded_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_scope               TEXT        NOT NULL
                                         CHECK (tenant_scope IN (
                                           'platform', 'organization', 'property',
                                           'external', 'migration'
                                         )),
  organization_id            UUID,
  property_id                UUID,
  scope_key                  TEXT        GENERATED ALWAYS AS (
                                            platform.tenant_scope_key(
                                              tenant_scope,
                                              organization_id,
                                              property_id
                                            )
                                          ) STORED,
  actor_type                 TEXT        NOT NULL DEFAULT 'system'
                                         CHECK (actor_type IN (
                                           'user', 'system', 'provider', 'migration'
                                         )),
  actor_user_id              UUID,
  target_resource_product    TEXT        NOT NULL,
  target_resource_type       TEXT        NOT NULL,
  target_resource_id         TEXT        NOT NULL,
  secondary_resource_product TEXT,
  secondary_resource_type    TEXT,
  secondary_resource_id      TEXT,
  domain_event_id            UUID,
  external_webhook_event_id  UUID,
  job_id                     UUID,
  idempotency_key_id         UUID,
  correlation_id             TEXT,
  causation_id               TEXT,
  redacted_payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  private_payload            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  audit_metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  retention_class            TEXT        NOT NULL DEFAULT 'standard'
                                         CHECK (retention_class IN (
                                           'standard', 'security', 'financial',
                                           'guest_pii', 'provider_receipt'
                                         )),
  privacy_scope              TEXT        NOT NULL DEFAULT 'internal'
                                         CHECK (privacy_scope IN (
                                           'internal', 'confidential', 'restricted'
                                         )),
  ai_visible                 BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_platform_product_audit_events_key
    UNIQUE (product, audit_key),
  CONSTRAINT chk_platform_product_audit_events_scope
    CHECK (platform.valid_tenant_scope(tenant_scope, organization_id, property_id)),
  CONSTRAINT chk_platform_product_audit_events_private
    CHECK (ai_visible = FALSE),
  CONSTRAINT fk_platform_product_audit_events_organization
    FOREIGN KEY (organization_id)
    REFERENCES identity.organizations(id),
  CONSTRAINT fk_platform_product_audit_events_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id),
  CONSTRAINT fk_platform_product_audit_events_actor
    FOREIGN KEY (actor_user_id)
    REFERENCES identity.users(id),
  CONSTRAINT fk_platform_product_audit_events_domain_event
    FOREIGN KEY (domain_event_id)
    REFERENCES platform.domain_events(id),
  CONSTRAINT fk_platform_product_audit_events_domain_event_scope
    FOREIGN KEY (domain_event_id, scope_key)
    REFERENCES platform.domain_events(id, scope_key),
  CONSTRAINT fk_platform_product_audit_events_webhook_event
    FOREIGN KEY (external_webhook_event_id)
    REFERENCES platform.external_webhook_events(id),
  CONSTRAINT fk_platform_product_audit_events_webhook_event_scope
    FOREIGN KEY (external_webhook_event_id, scope_key)
    REFERENCES platform.external_webhook_events(id, scope_key),
  CONSTRAINT fk_platform_product_audit_events_job
    FOREIGN KEY (job_id)
    REFERENCES platform.jobs(id),
  CONSTRAINT fk_platform_product_audit_events_job_scope
    FOREIGN KEY (job_id, scope_key)
    REFERENCES platform.jobs(id, scope_key),
  CONSTRAINT fk_platform_product_audit_events_idempotency_key
    FOREIGN KEY (idempotency_key_id)
    REFERENCES platform.idempotency_keys(id),
  CONSTRAINT fk_platform_product_audit_events_idempotency_key_scope
    FOREIGN KEY (idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key)
);

CREATE INDEX idx_platform_product_audit_events_target
  ON platform.product_audit_events (
    target_resource_product,
    target_resource_type,
    target_resource_id,
    occurred_at DESC
  );

CREATE INDEX idx_platform_product_audit_events_actor
  ON platform.product_audit_events (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE TRIGGER trg_platform_domain_events_append_only
  BEFORE UPDATE OR DELETE ON platform.domain_events
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_platform_external_webhook_events_append_only
  BEFORE UPDATE OR DELETE ON platform.external_webhook_events
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_platform_product_audit_events_append_only
  BEFORE UPDATE OR DELETE ON platform.product_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_append_only_mutation();
