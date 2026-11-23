-- Migration: 0553_platform_ai_operations
-- Owner: platform / VAY-2524
--
-- One row per AI change (engineering/ai-actions-design-note.md §4.6), written before anything runs.
-- The one executor of AI changes runs it; the model, the AI SDK, Mastra and the browser only create
-- or answer it.
--
-- An Ask-first change starts "pending" and waits up to 15 minutes (or its preview's own expiry) for
-- the person's Yes; a Yes starts it ("running") for exactly one caller under a lease whose token is
-- new at every start and take-over, and a later caller joins that run. A run whose lease ran out (a
-- deploy, a crash) is taken over by the recovery job, which runs the same steps again with the same
-- keys: each step's Idempotency-Key is derived from the operation id and the step, so the route
-- returns its stored answer instead of changing twice; after 5 attempts it gives up. A retried or
-- regenerated tool call with the same arguments finds the row by its business key (who, where, the
-- action, the arguments) and gets the same operation back: always while it is pending or running
-- (at most one such row has a key), and for a short while after it ended within the same request
-- scope (the in-app turn).
--
-- arguments are the AI's checked input to the action; they can hold text a person or the AI wrote
-- (a booking note), so rows are deleted after 90 days by the API's retention worker, with the
-- account, the property or the user. An ordinary table: the API login gets its DML from the default
-- privileges, no GRANT here.

SET LOCAL lock_timeout = '5s';

CREATE TABLE platform.ai_operations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  property_id      UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  user_id          UUID        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  surface          TEXT        NOT NULL CHECK (surface IN ('mcp', 'in_app')),
  -- The MCP connection (mcp) or the in-app conversation (in_app) the change came from.
  connection_id    UUID,
  conversation_id  UUID,
  -- The AI app or client, named as in platform.ai_tool_calls.
  client           TEXT        NOT NULL CHECK (client ~ '^[A-Za-z0-9:/._-]{1,200}$'),
  action           TEXT        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{2,63}$'),
  action_version   INTEGER     NOT NULL CHECK (action_version >= 1),
  action_group     TEXT        NOT NULL CHECK (action_group IN ('ask', 'do')),
  business_key     TEXT        NOT NULL CHECK (business_key ~ '^[0-9a-f]{64}$'),
  -- What tells a retry from a new request once the change ended (the in-app turn).
  request_scope    TEXT        CHECK (request_scope ~ '^[A-Za-z0-9:._-]{1,128}$'),
  arguments        JSONB       NOT NULL
                     CHECK (jsonb_typeof(arguments) = 'object'
                            AND octet_length(arguments::text) <= 32768),
  status           TEXT        NOT NULL
                     CHECK (status IN ('pending', 'running', 'done', 'failed', 'closed')),
  -- Why a pending change never ran: the person said No, nobody answered, the connection or
  -- conversation was closed, AI was switched off, or what it would change changed since it asked.
  close_reason     TEXT        CHECK (close_reason IN ('declined', 'expired', 'revoked',
                                                       'ai_switched_off', 'changed')),
  expires_at       TIMESTAMPTZ,
  -- The route's own preview the Yes binds to, where the action has one.
  preview_sha256   TEXT        CHECK (preview_sha256 ~ '^[0-9a-f]{64}$'),
  lease_owner      TEXT        CHECK (lease_owner ~ '^[A-Za-z0-9:._-]{1,128}$'),
  lease_expires_at TIMESTAMPTZ,
  -- How many times a run was started or taken over.
  attempts         INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Steps done so far, and what each request was (request id, key hash, status code): no answer text.
  step_cursor      INTEGER     NOT NULL DEFAULT 0 CHECK (step_cursor >= 0),
  steps            JSONB       NOT NULL DEFAULT '[]'::jsonb
                     CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 20),
  -- The action's allow-listed answer, for a retry that finds the row.
  result           JSONB       CHECK (octet_length(result::text) <= 32768),
  error_code       TEXT        CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  CONSTRAINT chk_platform_ai_operations_channel CHECK (
    (surface = 'mcp' AND connection_id IS NOT NULL AND conversation_id IS NULL)
    OR (surface = 'in_app' AND conversation_id IS NOT NULL AND connection_id IS NULL)
  ),
  CONSTRAINT chk_platform_ai_operations_lease CHECK (
    (lease_owner IS NULL) = (lease_expires_at IS NULL)
  ),
  CONSTRAINT chk_platform_ai_operations_state CHECK (
    (status = 'pending' AND action_group = 'ask' AND expires_at IS NOT NULL
     AND lease_owner IS NULL AND started_at IS NULL AND finished_at IS NULL
     AND close_reason IS NULL)
    OR (status = 'running' AND lease_owner IS NOT NULL AND started_at IS NOT NULL
        AND finished_at IS NULL AND close_reason IS NULL)
    OR (status IN ('done', 'failed') AND lease_owner IS NULL AND started_at IS NOT NULL
        AND finished_at IS NOT NULL AND close_reason IS NULL)
    OR (status = 'closed' AND close_reason IS NOT NULL AND lease_owner IS NULL
        AND started_at IS NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT chk_platform_ai_operations_outcome CHECK (
    (status = 'failed') = (error_code IS NOT NULL)
    AND (result IS NULL OR status = 'done')
  )
);

-- A retried tool call finds its operation (recent rows of one business key); at most one row of a
-- key is pending or running.
CREATE INDEX idx_platform_ai_operations_business_key
  ON platform.ai_operations (business_key, created_at DESC);
CREATE UNIQUE INDEX uq_platform_ai_operations_live_business_key
  ON platform.ai_operations (business_key) WHERE status IN ('pending', 'running');
-- The recovery job: runs whose lease ran out.
CREATE INDEX idx_platform_ai_operations_lease
  ON platform.ai_operations (lease_expires_at) WHERE status = 'running';
-- Closing unanswered changes.
CREATE INDEX idx_platform_ai_operations_pending
  ON platform.ai_operations (expires_at) WHERE status = 'pending';
-- Retention, and the account's, the user's and the property's changes (and their deletes).
CREATE INDEX idx_platform_ai_operations_created ON platform.ai_operations (created_at);
CREATE INDEX idx_platform_ai_operations_organization
  ON platform.ai_operations (organization_id, created_at DESC);
CREATE INDEX idx_platform_ai_operations_user
  ON platform.ai_operations (user_id, created_at DESC);
CREATE INDEX idx_platform_ai_operations_property ON platform.ai_operations (property_id);
