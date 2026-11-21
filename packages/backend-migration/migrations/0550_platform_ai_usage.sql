-- Migration: 0550_platform_ai_usage
-- Owner: platform / VAY-2504
--
-- The AI usage ledger and each hotel account's monthly AI budget (plan 3.9, design note §8.2).
--
-- Every model call is one ledger row. It is written as a reservation of the call's highest
-- possible cost before the call, inside a per-account lock, and settled with the real tokens and
-- cost afterwards. A reservation that is never settled (the task died) stops counting as running
-- at hold_until and keeps counting at its reserved amount. No prompt or answer text is stored.
--
-- A budget row exists only for an account whose monthly AI allowance vayada staff have set;
-- every other account gets the API's configured default. Hotel owners can not change it.
--
-- New product tables: the API login gets its DML from the default privileges (no GRANT here).

SET LOCAL lock_timeout = '5s';

CREATE TABLE platform.ai_budgets (
  organization_id         UUID        PRIMARY KEY
                            REFERENCES identity.organizations(id) ON DELETE CASCADE,
  monthly_limit_micro_usd BIGINT      NOT NULL CHECK (monthly_limit_micro_usd >= 0),
  updated_by_user_id      UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform.ai_usage_ledger (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID        NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  property_id         UUID        REFERENCES hotel_catalog.properties(id) ON DELETE SET NULL,
  user_id             UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  surface             TEXT        NOT NULL
                        CHECK (surface IN ('inbox', 'assistant', 'concierge', 'model_test')),
  task                TEXT        NOT NULL CHECK (task ~ '^[a-z][a-z_]{0,63}$'),
  request_id          TEXT        NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  provider            TEXT        NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  region              TEXT        NOT NULL CHECK (length(region) BETWEEN 1 AND 64),
  model               TEXT        NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  price_table_version TEXT        NOT NULL CHECK (length(price_table_version) BETWEEN 1 AND 32),
  budget_month        DATE        NOT NULL CHECK (budget_month = date_trunc('month', budget_month)::date),
  status              TEXT        NOT NULL DEFAULT 'reserved'
                        CHECK (status IN ('reserved', 'completed', 'failed')),
  reserved_micro_usd  BIGINT      NOT NULL CHECK (reserved_micro_usd >= 0),
  cost_micro_usd      BIGINT      CHECK (cost_micro_usd >= 0),
  input_tokens        INTEGER     CHECK (input_tokens >= 0),
  cache_read_tokens   INTEGER     CHECK (cache_read_tokens >= 0),
  cache_write_tokens  INTEGER     CHECK (cache_write_tokens >= 0),
  output_tokens       INTEGER     CHECK (output_tokens >= 0),
  reserved_at         TIMESTAMPTZ NOT NULL,
  hold_until          TIMESTAMPTZ NOT NULL,
  settled_at          TIMESTAMPTZ,
  CONSTRAINT chk_platform_ai_usage_ledger_hold CHECK (hold_until > reserved_at),
  CONSTRAINT chk_platform_ai_usage_ledger_settled CHECK (
    (status = 'reserved' AND settled_at IS NULL AND cost_micro_usd IS NULL)
    OR (status <> 'reserved' AND settled_at IS NOT NULL AND cost_micro_usd IS NOT NULL)
  ),
  CONSTRAINT chk_platform_ai_usage_ledger_tokens CHECK (
    status = 'completed'
    OR (input_tokens IS NULL AND cache_read_tokens IS NULL
        AND cache_write_tokens IS NULL AND output_tokens IS NULL)
  )
);

-- An account's month, read under the account's lock before every call.
CREATE INDEX idx_platform_ai_usage_ledger_account_month
  ON platform.ai_usage_ledger (organization_id, budget_month);

-- vayada's total for the month, for the spending alert.
CREATE INDEX idx_platform_ai_usage_ledger_month ON platform.ai_usage_ledger (budget_month);
