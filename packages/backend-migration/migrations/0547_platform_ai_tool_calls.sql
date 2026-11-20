-- Migration: 0547_platform_ai_tool_calls
-- Owner: platform / VAY-2508
--
-- One row per AI action (engineering/ai-actions-design-note.md §7): who acted (user, account,
-- property), through which AI surface and app or feature, which action and group, which records
-- it read or changed, how it ended, and the keys that join it to the route's own audit rows:
-- request_id is the tool-call id the route saw as its request id, correlation_id a change's
-- operation id, idempotency_key_hash the SHA-256 of the Idempotency-Key it sent (the same hash as
-- platform.idempotency_keys.key_hash).
--
-- No guest text and no tool output is stored: arguments keep ids, dates, numbers, booleans and
-- named enum tokens, any other string only as its length; records are a type and a UUID. Rows are
-- deleted after two years by the API's retention worker, so this is an ordinary table (the API
-- login gets its DML from the default privileges, no GRANT here), not append-only evidence.

SET LOCAL lock_timeout = '5s';

CREATE TABLE platform.ai_tool_calls (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  organization_id       UUID        NOT NULL REFERENCES identity.organizations(id),
  property_id           UUID        REFERENCES hotel_catalog.properties(id),
  user_id               UUID        NOT NULL REFERENCES identity.users(id),
  surface               TEXT        NOT NULL
                          CHECK (surface IN ('mcp', 'in_app', 'inbox_assist', 'concierge')),
  client                TEXT        NOT NULL CHECK (client ~ '^[A-Za-z0-9:/._-]{1,200}$'),
  connection_id         UUID,
  conversation_id       UUID,
  action                TEXT        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{0,79}$'),
  action_version        INTEGER     NOT NULL DEFAULT 1 CHECK (action_version >= 1),
  action_group          TEXT        NOT NULL
                          CHECK (action_group IN ('R0', 'R1', 'R2-finance', 'R2', 'do', 'ask')),
  arguments             JSONB       NOT NULL DEFAULT '{}'::jsonb
                          CHECK (octet_length(arguments::text) <= 16384),
  records_read          JSONB       NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(records_read) = 'array'
                                 AND jsonb_array_length(records_read) <= 200),
  records_changed       JSONB       NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(records_changed) = 'array'
                                 AND jsonb_array_length(records_changed) <= 200),
  outcome               TEXT        NOT NULL
                          CHECK (outcome IN ('ok', 'denied', 'invalid', 'refused', 'failed')),
  error_code            TEXT        CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  latency_ms            INTEGER     NOT NULL CHECK (latency_ms >= 0),
  -- Guest text, contact data or finance read (R2): a security event.
  sensitive             BOOLEAN     NOT NULL DEFAULT FALSE,
  request_id            TEXT        NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  correlation_id        TEXT        CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  idempotency_key_hash  TEXT        CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  operation_id          UUID,
  -- Provider tool-call id or MCP JSON-RPC id: logged, never the identity.
  external_call_id      TEXT        CHECK (char_length(external_call_id) BETWEEN 1 AND 128),
  -- provider/model/region of a model call vayada pays for.
  model                 TEXT        CHECK (model ~ '^[A-Za-z0-9:/._-]{1,200}$')
);

-- The AI activity list: the whole account (owner) or one user, newest first.
CREATE INDEX idx_platform_ai_tool_calls_organization
  ON platform.ai_tool_calls (organization_id, occurred_at DESC, id DESC);
CREATE INDEX idx_platform_ai_tool_calls_user
  ON platform.ai_tool_calls (organization_id, user_id, occurred_at DESC, id DESC);
-- Joins to the route's audit rows and retention.
CREATE INDEX idx_platform_ai_tool_calls_request ON platform.ai_tool_calls (request_id);
CREATE INDEX idx_platform_ai_tool_calls_correlation
  ON platform.ai_tool_calls (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_platform_ai_tool_calls_occurred ON platform.ai_tool_calls (occurred_at);
