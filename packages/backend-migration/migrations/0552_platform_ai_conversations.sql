-- Migration: 0552_platform_ai_conversations
-- Owner: platform / VAY-2518
--
-- The in-app assistant's chat history (plan 3.9, research 04 §7). vayada keeps it; the AI provider
-- stores nothing.
--
-- A conversation belongs to one user, one property and one app, and only that user reads it. It
-- records the request contract it was started with (provider, region, model, system prompt, call
-- settings, the tool definitions in their order): Claude's thinking replay binds that whole
-- prefix, so a question whose contract differs (after a deploy or a permission change) can't
-- continue it, and the panel starts a new one. That is decided per request, not stored: during a
-- rolling deploy old and new API tasks both answer. Only "too long" (100 turns or ~150K tokens)
-- is stored.
--
-- A turn is one question and everything the assistant did for it. At most one turn per
-- conversation runs at a time; its heartbeat shows that the API task running it is still alive.
-- A turn cut off by a deploy is closed as "interrupted", with an error result for every tool call
-- it never answered, so the history stays valid and shows what did and did not happen.
--
-- Messages are kept exactly as the provider layer handed them over, in order, and never changed
-- (replay must be identical); tool_call_ids lets the API check that each tool call is answered
-- once. Conversations, with their turns and messages, are deleted 30 days after their last activity
-- by the API's retention worker, so these are ordinary tables (the API login gets its DML from the
-- default privileges, no GRANT here).

SET LOCAL lock_timeout = '5s';

CREATE TABLE platform.ai_conversations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  property_id      UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  user_id          UUID        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  app              TEXT        NOT NULL CHECK (app IN ('pms', 'booking_admin')),
  -- For support: only the hash is compared.
  contract         JSONB       NOT NULL
                     CHECK (jsonb_typeof(contract) = 'object'
                            AND octet_length(contract::text) <= 65536),
  contract_sha256  TEXT        NOT NULL CHECK (contract_sha256 ~ '^[0-9a-f]{64}$'),
  -- NULL while the conversation can continue.
  read_only_reason TEXT        CHECK (read_only_reason IN ('too_long')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Your chats": one user's conversations for one property (and app), newest first.
CREATE INDEX idx_platform_ai_conversations_user_property
  ON platform.ai_conversations (user_id, property_id, last_activity_at DESC, id DESC);
-- Retention, and deleting an account or a property.
CREATE INDEX idx_platform_ai_conversations_last_activity
  ON platform.ai_conversations (last_activity_at);
CREATE INDEX idx_platform_ai_conversations_organization
  ON platform.ai_conversations (organization_id);
CREATE INDEX idx_platform_ai_conversations_property
  ON platform.ai_conversations (property_id);

CREATE TABLE platform.ai_conversation_turns (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL
                    REFERENCES platform.ai_conversations(id) ON DELETE CASCADE,
  seq             INTEGER     NOT NULL CHECK (seq >= 1),
  status          TEXT        NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'done', 'waiting_for_answer', 'stopped',
                                      'failed', 'interrupted')),
  -- Why a turn stopped, failed or was interrupted (step_limit, allowance_used_up, shutdown...).
  end_reason      TEXT        CHECK (end_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  CONSTRAINT uq_platform_ai_conversation_turns_seq UNIQUE (conversation_id, seq),
  CONSTRAINT uq_platform_ai_conversation_turns_conversation UNIQUE (id, conversation_id),
  CONSTRAINT chk_platform_ai_conversation_turns_ended
    CHECK ((status = 'running') = (ended_at IS NULL))
);

-- One running turn per conversation: a second tab or a double click is told "busy".
CREATE UNIQUE INDEX uq_platform_ai_conversation_turns_running
  ON platform.ai_conversation_turns (conversation_id) WHERE status = 'running';

CREATE TABLE platform.ai_conversation_messages (
  conversation_id UUID        NOT NULL,
  seq             INTEGER     NOT NULL CHECK (seq >= 1),
  turn_id         UUID        NOT NULL,
  role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  -- The whole message as the provider layer handed it over (role, content, provider options).
  -- json, not jsonb: jsonb reorders object keys (tool arguments, tool results), and a replayed
  -- request must match the cached prefix and the signed thinking byte for byte.
  message         JSON        NOT NULL
                    CHECK (json_typeof(message) = 'object'
                           AND message ->> 'role' = role
                           AND octet_length(message::text) <= 262144),
  -- assistant: the tool calls it made; tool: the tool calls it answers.
  tool_call_ids   TEXT[]      NOT NULL DEFAULT '{}'
                    CHECK (cardinality(tool_call_ids) <= 64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq),
  CONSTRAINT fk_platform_ai_conversation_messages_turn
    FOREIGN KEY (turn_id, conversation_id)
    REFERENCES platform.ai_conversation_turns (id, conversation_id) ON DELETE CASCADE
);

-- Replay must send history exactly as stored: rows are only ever added, or deleted with their
-- conversation.
CREATE TRIGGER trg_platform_ai_conversation_messages_no_update
  BEFORE UPDATE ON platform.ai_conversation_messages
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
