-- Migration: 0007_finance
-- Owner: domain-finance
-- See: engineering/target-schema-migration-coverage.md, engineering/target-schema-ownership-map.md
--
-- Creates the finance target schema for payment provider accounts, property
-- payment and payout settings, payment/payout facts, commission rules,
-- billing entitlement source state, and permissioned finance visibility.
--
-- Legacy Booking/PMS/Marketplace databases are migration/parity inputs only.
-- Runtime TypeScript code must not use this migration as a reason to read
-- legacy product databases directly.

CREATE SCHEMA IF NOT EXISTS finance;

CREATE TABLE finance.payment_provider_accounts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID        REFERENCES hotel_catalog.properties(id),
  organization_id          UUID        REFERENCES identity.organizations(id),
  account_scope            TEXT        NOT NULL
                               CHECK (account_scope IN ('property', 'organization', 'platform', 'migration')),
  provider                 TEXT        NOT NULL
                               CHECK (provider IN (
                                 'stripe', 'paypal', 'xendit', 'vayada',
                                 'manual', 'bank_transfer', 'migration'
                               )),
  provider_account_id      TEXT,
  status                   TEXT        NOT NULL DEFAULT 'setup_incomplete'
                               CHECK (status IN (
                                 'setup_incomplete', 'pending', 'active',
                                 'restricted', 'suspended', 'disabled'
                               )),
  onboarding_status        TEXT        NOT NULL DEFAULT 'not_started'
                               CHECK (onboarding_status IN (
                                 'not_started', 'invited', 'in_review',
                                 'completed', 'requires_action'
                               )),
  charges_enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  payouts_enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  default_currency         CHAR(3),
  capabilities             TEXT[]      NOT NULL DEFAULT '{}',
  account_metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sensitive_config_ref     TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_payment_provider_accounts_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_finance_payment_provider_accounts_id_organization
    UNIQUE (id, organization_id),
  CONSTRAINT chk_finance_payment_provider_accounts_scope
    CHECK (
      (account_scope = 'property' AND property_id IS NOT NULL AND organization_id IS NULL)
      OR (account_scope = 'organization' AND property_id IS NULL AND organization_id IS NOT NULL)
      OR (account_scope = 'platform' AND property_id IS NULL AND organization_id IS NULL)
      OR account_scope = 'migration'
    ),
  CONSTRAINT chk_finance_payment_provider_accounts_currency_upper
    CHECK (default_currency IS NULL OR default_currency = upper(default_currency)),
  CONSTRAINT chk_finance_payment_provider_accounts_provider_ref
    CHECK (
      provider IN ('manual', 'bank_transfer', 'vayada', 'migration')
      OR provider_account_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX uq_finance_payment_provider_accounts_provider_ref
  ON finance.payment_provider_accounts (provider, provider_account_id)
  WHERE provider_account_id IS NOT NULL;

CREATE INDEX idx_finance_payment_provider_accounts_property
  ON finance.payment_provider_accounts (property_id, status);

CREATE INDEX idx_finance_payment_provider_accounts_organization
  ON finance.payment_provider_accounts (organization_id, status);

CREATE TABLE finance.payment_settings (
  property_id              UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  provider_account_id      UUID,
  payments_enabled         BOOLEAN     NOT NULL DEFAULT FALSE,
  accepted_methods         TEXT[]      NOT NULL DEFAULT '{}',
  default_currency         CHAR(3)     NOT NULL,
  deposit_policy           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  refund_policy            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  tax_policy               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  statement_descriptor     TEXT,
  requires_manual_review   BOOLEAN     NOT NULL DEFAULT FALSE,
  source_system            TEXT        NOT NULL DEFAULT 'finance'
                               CHECK (source_system IN ('finance', 'booking', 'pms', 'marketplace', 'migration')),
  source_settings_id       TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_finance_payment_settings_currency_upper
    CHECK (default_currency = upper(default_currency)),
  CONSTRAINT chk_finance_payment_settings_accepted_methods
    CHECK (
      accepted_methods <@ ARRAY[
        'card', 'pay_at_property', 'xendit', 'cash',
        'bank_transfer', 'manual_card', 'wallet', 'other'
      ]::TEXT[]
    ),
  CONSTRAINT chk_finance_payment_settings_source_id
    CHECK (source_system = 'finance' OR source_settings_id IS NOT NULL),
  CONSTRAINT fk_finance_payment_settings_provider_account_property
    FOREIGN KEY (provider_account_id, property_id)
    REFERENCES finance.payment_provider_accounts(id, property_id)
    ON DELETE SET NULL (provider_account_id)
);

CREATE TABLE finance.payments (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  organization_id          UUID        REFERENCES identity.organizations(id),
  guest_booking_id         UUID,
  provider_account_id      UUID,
  source_system            TEXT        NOT NULL DEFAULT 'finance'
                               CHECK (source_system IN ('finance', 'booking', 'pms', 'marketplace', 'migration')),
  source_payment_id        TEXT,
  idempotency_key          TEXT,
  payment_kind             TEXT        NOT NULL
                               CHECK (payment_kind IN ('deposit', 'balance', 'full', 'refund', 'adjustment', 'manual')),
  payment_method           TEXT        NOT NULL DEFAULT 'unknown'
                               CHECK (payment_method IN (
                                 'card', 'pay_at_property', 'xendit',
                                 'bank_transfer', 'wallet', 'cash',
                                 'manual_card', 'other', 'unknown'
                               )),
  status                   TEXT        NOT NULL
                               CHECK (status IN (
                                 'requires_action', 'authorized', 'pending',
                                 'paid', 'partially_refunded', 'refunded',
                                 'failed', 'canceled', 'disputed'
                               )),
  amount                   NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
  fee_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  net_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  refunded_amount          NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  currency                 CHAR(3)     NOT NULL,
  provider_transaction_id  TEXT,
  provider_payment_intent_id TEXT,
  processor_fee_breakdown  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  risk_review              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  payment_metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  visibility_class         TEXT        NOT NULL DEFAULT 'finance_private'
                               CHECK (visibility_class IN (
                                 'finance_private', 'pms_finance',
                                 'affiliate_finance', 'migration'
                               )),
  authorized_at            TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  failed_at                TIMESTAMPTZ,
  disputed_at              TIMESTAMPTZ,
  pii_retention_until      DATE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_payments_source
    UNIQUE (source_system, source_payment_id),
  CONSTRAINT uq_finance_payments_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_finance_payments_id_property_booking
    UNIQUE (id, property_id, guest_booking_id),
  CONSTRAINT chk_finance_payments_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_finance_payments_refund_amount
    CHECK (refunded_amount <= amount),
  CONSTRAINT chk_finance_payments_source_id
    CHECK (source_system = 'finance' OR source_payment_id IS NOT NULL),
  CONSTRAINT fk_finance_payments_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE SET NULL (guest_booking_id),
  CONSTRAINT fk_finance_payments_provider_account_property
    FOREIGN KEY (provider_account_id, property_id)
    REFERENCES finance.payment_provider_accounts(id, property_id)
    ON DELETE SET NULL (provider_account_id)
);

CREATE UNIQUE INDEX uq_finance_payments_idempotency_key
  ON finance.payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX uq_finance_payments_provider_transaction
  ON finance.payments (provider_account_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE INDEX idx_finance_payments_property_status
  ON finance.payments (property_id, status, created_at);

CREATE INDEX idx_finance_payments_guest_booking
  ON finance.payments (guest_booking_id);

CREATE TABLE finance.payout_settings (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID        REFERENCES hotel_catalog.properties(id),
  organization_id          UUID        REFERENCES identity.organizations(id),
  property_provider_account_id UUID,
  organization_provider_account_id UUID,
  owner_scope              TEXT        NOT NULL
                               CHECK (owner_scope IN ('property', 'organization', 'platform', 'migration')),
  payout_method            TEXT        NOT NULL DEFAULT 'bank_account'
                               CHECK (payout_method IN (
                                 'paypal', 'bank', 'stripe', 'xendit',
                                 'bank_account', 'wallet', 'manual', 'none'
                               )),
  destination_country_code CHAR(2),
  default_currency         CHAR(3)     NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'setup_incomplete'
                               CHECK (status IN ('setup_incomplete', 'active', 'paused', 'disabled')),
  schedule                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  payout_preferences       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sensitive_destination_ref TEXT,
  source_system            TEXT        NOT NULL DEFAULT 'finance'
                               CHECK (source_system IN ('finance', 'booking', 'pms', 'marketplace', 'migration')),
  source_settings_id       TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_finance_payout_settings_scope
    CHECK (
      (owner_scope = 'property' AND property_id IS NOT NULL AND organization_id IS NULL)
      OR (owner_scope = 'organization' AND property_id IS NULL AND organization_id IS NOT NULL)
      OR (owner_scope = 'platform' AND property_id IS NULL AND organization_id IS NULL)
      OR owner_scope = 'migration'
    ),
  CONSTRAINT uq_finance_payout_settings_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_finance_payout_settings_id_organization
    UNIQUE (id, organization_id),
  CONSTRAINT chk_finance_payout_settings_provider_scope
    CHECK (
      NOT (
        property_provider_account_id IS NOT NULL
        AND organization_provider_account_id IS NOT NULL
      )
      AND (
        owner_scope = 'property'
        OR property_provider_account_id IS NULL
      )
      AND (
        owner_scope = 'organization'
        OR organization_provider_account_id IS NULL
      )
    ),
  CONSTRAINT chk_finance_payout_settings_currency_upper
    CHECK (default_currency = upper(default_currency)),
  CONSTRAINT chk_finance_payout_settings_country_upper
    CHECK (destination_country_code IS NULL OR destination_country_code = upper(destination_country_code)),
  CONSTRAINT chk_finance_payout_settings_source_id
    CHECK (source_system = 'finance' OR source_settings_id IS NOT NULL),
  CONSTRAINT fk_finance_payout_settings_property_provider_account
    FOREIGN KEY (property_provider_account_id, property_id)
    REFERENCES finance.payment_provider_accounts(id, property_id)
    ON DELETE SET NULL (property_provider_account_id),
  CONSTRAINT fk_finance_payout_settings_organization_provider_account
    FOREIGN KEY (organization_provider_account_id, organization_id)
    REFERENCES finance.payment_provider_accounts(id, organization_id)
    ON DELETE SET NULL (organization_provider_account_id)
);

CREATE INDEX idx_finance_payout_settings_property
  ON finance.payout_settings (property_id, status);

CREATE INDEX idx_finance_payout_settings_organization
  ON finance.payout_settings (organization_id, status);

CREATE TABLE finance.payouts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_setting_id        UUID,
  payment_id               UUID,
  guest_booking_id         UUID,
  property_provider_account_id UUID,
  organization_provider_account_id UUID,
  owner_scope              TEXT        NOT NULL
                               CHECK (owner_scope IN ('property', 'organization', 'platform', 'migration')),
  property_id              UUID        REFERENCES hotel_catalog.properties(id),
  organization_id          UUID        REFERENCES identity.organizations(id),
  related_property_id      UUID        REFERENCES hotel_catalog.properties(id),
  source_system            TEXT        NOT NULL DEFAULT 'finance'
                               CHECK (source_system IN ('finance', 'booking', 'pms', 'marketplace', 'migration')),
  source_payout_id         TEXT,
  payout_status            TEXT        NOT NULL
                               CHECK (payout_status IN (
                                 'pending', 'scheduled', 'processing',
                                 'paid', 'failed', 'canceled', 'reversed'
                               )),
  amount                   NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
  fee_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  net_amount               NUMERIC(15, 2) NOT NULL DEFAULT 0,
  currency                 CHAR(3)     NOT NULL,
  period_start             DATE,
  period_end               DATE,
  provider_payout_id       TEXT,
  scheduled_at             TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  failed_at                TIMESTAMPTZ,
  failure_code             TEXT,
  retry_count              INTEGER     NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  payout_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_payouts_source
    UNIQUE (source_system, source_payout_id),
  CONSTRAINT uq_finance_payouts_id_property
    UNIQUE (id, property_id),
  CONSTRAINT chk_finance_payouts_scope
    CHECK (
      (owner_scope = 'property' AND property_id IS NOT NULL AND organization_id IS NULL)
      OR (owner_scope = 'organization' AND property_id IS NULL AND organization_id IS NOT NULL)
      OR (owner_scope = 'platform' AND property_id IS NULL AND organization_id IS NULL)
      OR owner_scope = 'migration'
    ),
  CONSTRAINT chk_finance_payouts_provider_scope
    CHECK (
      NOT (
        property_provider_account_id IS NOT NULL
        AND organization_provider_account_id IS NOT NULL
      )
      AND (
        owner_scope = 'property'
        OR property_provider_account_id IS NULL
      )
      AND (
        owner_scope = 'organization'
        OR organization_provider_account_id IS NULL
      )
    ),
  CONSTRAINT chk_finance_payouts_related_property
    CHECK (
      (
        payment_id IS NULL
        AND guest_booking_id IS NULL
        AND related_property_id IS NULL
      )
      OR related_property_id IS NOT NULL
    ),
  CONSTRAINT chk_finance_payouts_property_owner_related_property
    CHECK (
      owner_scope <> 'property'
      OR related_property_id IS NULL
      OR related_property_id = property_id
    ),
  CONSTRAINT chk_finance_payouts_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_finance_payouts_period_order
    CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
  CONSTRAINT chk_finance_payouts_source_id
    CHECK (source_system = 'finance' OR source_payout_id IS NOT NULL),
  CONSTRAINT fk_finance_payouts_property_payout_setting
    FOREIGN KEY (payout_setting_id, property_id)
    REFERENCES finance.payout_settings(id, property_id)
    ON DELETE SET NULL (payout_setting_id),
  CONSTRAINT fk_finance_payouts_organization_payout_setting
    FOREIGN KEY (payout_setting_id, organization_id)
    REFERENCES finance.payout_settings(id, organization_id)
    ON DELETE SET NULL (payout_setting_id),
  CONSTRAINT fk_finance_payouts_property_provider_account
    FOREIGN KEY (property_provider_account_id, property_id)
    REFERENCES finance.payment_provider_accounts(id, property_id)
    ON DELETE SET NULL (property_provider_account_id),
  CONSTRAINT fk_finance_payouts_organization_provider_account
    FOREIGN KEY (organization_provider_account_id, organization_id)
    REFERENCES finance.payment_provider_accounts(id, organization_id)
    ON DELETE SET NULL (organization_provider_account_id),
  CONSTRAINT fk_finance_payouts_payment_property
    FOREIGN KEY (payment_id, related_property_id)
    REFERENCES finance.payments(id, property_id)
    ON DELETE SET NULL (payment_id),
  CONSTRAINT fk_finance_payouts_booking_property
    FOREIGN KEY (guest_booking_id, related_property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE SET NULL (guest_booking_id),
  CONSTRAINT fk_finance_payouts_payment_booking
    FOREIGN KEY (payment_id, related_property_id, guest_booking_id)
    REFERENCES finance.payments(id, property_id, guest_booking_id)
    ON DELETE SET NULL (payment_id)
);

CREATE UNIQUE INDEX uq_finance_payouts_property_provider_payout
  ON finance.payouts (property_provider_account_id, provider_payout_id)
  WHERE provider_payout_id IS NOT NULL;

CREATE UNIQUE INDEX uq_finance_payouts_organization_provider_payout
  ON finance.payouts (organization_provider_account_id, provider_payout_id)
  WHERE provider_payout_id IS NOT NULL;

CREATE INDEX idx_finance_payouts_property_status
  ON finance.payouts (property_id, payout_status, created_at);

CREATE INDEX idx_finance_payouts_organization_status
  ON finance.payouts (organization_id, payout_status, created_at);

CREATE TABLE finance.commission_rules (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID        REFERENCES hotel_catalog.properties(id),
  organization_id          UUID        REFERENCES identity.organizations(id),
  rule_scope               TEXT        NOT NULL
                               CHECK (rule_scope IN (
                                 'property', 'organization', 'marketplace',
                                 'affiliate', 'platform', 'migration'
                               )),
  product                  TEXT        NOT NULL
                               CHECK (product IN ('platform', 'marketplace', 'booking', 'pms', 'affiliate')),
  commission_type          TEXT        NOT NULL
                               CHECK (commission_type IN ('percentage', 'fixed', 'hybrid', 'manual')),
  percentage_rate          NUMERIC(7, 4) CHECK (percentage_rate IS NULL OR percentage_rate BETWEEN 0 AND 100),
  fixed_amount             NUMERIC(15, 2) CHECK (fixed_amount IS NULL OR fixed_amount >= 0),
  currency                 CHAR(3),
  status                   TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'inactive', 'retired')),
  starts_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at                  TIMESTAMPTZ,
  source_system            TEXT        NOT NULL DEFAULT 'finance'
                               CHECK (source_system IN ('finance', 'booking', 'pms', 'marketplace', 'migration')),
  source_rule_id           TEXT,
  rule_metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_commission_rules_source
    UNIQUE (source_system, source_rule_id),
  CONSTRAINT chk_finance_commission_rules_scope
    CHECK (
      (rule_scope = 'property' AND property_id IS NOT NULL)
      OR (rule_scope IN ('organization', 'marketplace', 'affiliate') AND organization_id IS NOT NULL)
      OR (rule_scope = 'platform' AND property_id IS NULL AND organization_id IS NULL)
      OR rule_scope = 'migration'
    ),
  CONSTRAINT chk_finance_commission_rules_currency_upper
    CHECK (currency IS NULL OR currency = upper(currency)),
  CONSTRAINT chk_finance_commission_rules_date_order
    CHECK (ends_at IS NULL OR starts_at <= ends_at),
  CONSTRAINT chk_finance_commission_rules_rate_shape
    CHECK (
      (commission_type = 'percentage' AND percentage_rate IS NOT NULL)
      OR (commission_type = 'fixed' AND fixed_amount IS NOT NULL AND currency IS NOT NULL)
      OR (
        commission_type = 'hybrid'
        AND percentage_rate IS NOT NULL
        AND fixed_amount IS NOT NULL
        AND currency IS NOT NULL
      )
      OR commission_type = 'manual'
    ),
  CONSTRAINT chk_finance_commission_rules_source_id
    CHECK (source_system = 'finance' OR source_rule_id IS NOT NULL)
);

CREATE INDEX idx_finance_commission_rules_property
  ON finance.commission_rules (property_id, status);

CREATE INDEX idx_finance_commission_rules_organization
  ON finance.commission_rules (organization_id, status);

CREATE TABLE finance.commission_rate_changes (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_rule_id       UUID        NOT NULL,
  changed_by_user_id       UUID,
  previous_percentage_rate NUMERIC(7, 4) CHECK (
                                 previous_percentage_rate IS NULL
                                 OR previous_percentage_rate BETWEEN 0 AND 100
                               ),
  new_percentage_rate      NUMERIC(7, 4) CHECK (
                                 new_percentage_rate IS NULL
                                 OR new_percentage_rate BETWEEN 0 AND 100
                               ),
  previous_fixed_amount    NUMERIC(15, 2) CHECK (
                                 previous_fixed_amount IS NULL
                                 OR previous_fixed_amount >= 0
                               ),
  new_fixed_amount         NUMERIC(15, 2) CHECK (
                                 new_fixed_amount IS NULL
                                 OR new_fixed_amount >= 0
                               ),
  currency                 CHAR(3),
  reason                   TEXT,
  effective_at             TIMESTAMPTZ NOT NULL,
  changed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_finance_commission_rate_changes_currency_upper
    CHECK (currency IS NULL OR currency = upper(currency)),
  CONSTRAINT chk_finance_commission_rate_changes_value_present
    CHECK (
      previous_percentage_rate IS NOT NULL
      OR new_percentage_rate IS NOT NULL
      OR previous_fixed_amount IS NOT NULL
      OR new_fixed_amount IS NOT NULL
    ),
  CONSTRAINT fk_finance_commission_changes_rule
    FOREIGN KEY (commission_rule_id)
    REFERENCES finance.commission_rules(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_finance_commission_changes_actor
    FOREIGN KEY (changed_by_user_id)
    REFERENCES identity.users(id)
    ON DELETE SET NULL
);

CREATE INDEX idx_finance_commission_rate_changes_rule
  ON finance.commission_rate_changes (commission_rule_id, changed_at);

CREATE TABLE finance.billing_entitlements (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID        NOT NULL REFERENCES identity.organizations(id),
  property_id              UUID        REFERENCES hotel_catalog.properties(id),
  identity_entitlement_id  UUID,
  product                  TEXT        NOT NULL
                               CHECK (product IN ('platform', 'marketplace', 'booking', 'pms', 'affiliate')),
  entitlement_key          TEXT        NOT NULL,
  billing_status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (billing_status IN (
                                 'trialing', 'active', 'past_due',
                                 'suspended', 'expired', 'canceled'
                               )),
  plan_key                 TEXT,
  seat_count               INTEGER     CHECK (seat_count IS NULL OR seat_count >= 0),
  billing_provider         TEXT        NOT NULL DEFAULT 'manual'
                               CHECK (billing_provider IN ('stripe', 'manual', 'migration', 'none')),
  billing_customer_ref     TEXT,
  billing_subscription_ref TEXT,
  billing_period_start     DATE,
  billing_period_end       DATE,
  starts_at                TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
  source_system            TEXT        NOT NULL DEFAULT 'finance'
                               CHECK (source_system IN ('finance', 'booking', 'pms', 'marketplace', 'migration')),
  source_entitlement_id    TEXT,
  entitlement_metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_billing_entitlements_source
    UNIQUE (source_system, source_entitlement_id),
  CONSTRAINT chk_finance_billing_entitlements_period_order
    CHECK (billing_period_start IS NULL OR billing_period_end IS NULL OR billing_period_start <= billing_period_end),
  CONSTRAINT chk_finance_billing_entitlements_date_order
    CHECK (starts_at IS NULL OR expires_at IS NULL OR starts_at <= expires_at),
  CONSTRAINT chk_finance_billing_entitlements_source_id
    CHECK (source_system = 'finance' OR source_entitlement_id IS NOT NULL),
  CONSTRAINT fk_finance_billing_entitlements_identity_entitlement
    FOREIGN KEY (identity_entitlement_id)
    REFERENCES identity.product_entitlements(id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_finance_billing_entitlements_scope
  ON finance.billing_entitlements (
    organization_id,
    product,
    entitlement_key,
    COALESCE(property_id::text, '')
  );

CREATE INDEX idx_finance_billing_entitlements_org_status
  ON finance.billing_entitlements (organization_id, billing_status);

CREATE INDEX idx_finance_billing_entitlements_property
  ON finance.billing_entitlements (property_id, product);

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('platform.finance.read',    'platform',    'Read platform-level finance visibility summaries'),
  ('marketplace.finance.read', 'marketplace', 'Read marketplace finance visibility summaries')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE finance.finance_visibility_read_model (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            UUID        NOT NULL REFERENCES identity.organizations(id),
  property_id                UUID,
  visibility_scope           TEXT        NOT NULL
                                 CHECK (visibility_scope IN (
                                   'property_finance', 'organization_finance',
                                   'affiliate_payout', 'platform_finance'
                                 )),
  resource_type              TEXT        NOT NULL
                                 CHECK (resource_type IN (
                                   'property', 'organization', 'affiliate',
                                   'marketplace', 'platform'
                                 )),
  resource_id                TEXT        NOT NULL,
  required_permission_key    TEXT        NOT NULL,
  period_start               DATE,
  period_end                 DATE,
  currency                   CHAR(3)     NOT NULL,
  gross_payment_amount       NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (gross_payment_amount >= 0),
  net_payment_amount         NUMERIC(15, 2) NOT NULL DEFAULT 0,
  payout_amount              NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (payout_amount >= 0),
  commission_amount          NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  outstanding_balance_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
  payment_count              INTEGER     NOT NULL DEFAULT 0 CHECK (payment_count >= 0),
  payout_count               INTEGER     NOT NULL DEFAULT 0 CHECK (payout_count >= 0),
  failed_payment_count       INTEGER     NOT NULL DEFAULT 0 CHECK (failed_payment_count >= 0),
  entitlement_status         TEXT
                                 CHECK (
                                   entitlement_status IS NULL
                                   OR entitlement_status IN (
                                     'trialing', 'active', 'past_due',
                                     'suspended', 'expired', 'canceled'
                                   )
                                 ),
  status_counts              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  entitlement_summary        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  projected_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_finance_visibility_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_finance_visibility_period_order
    CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
  CONSTRAINT chk_finance_visibility_requires_permission
    CHECK (
      required_permission_key IN (
        'pms.finance.read',
        'affiliate.payout.manage',
        'platform.finance.read',
        'marketplace.finance.read'
      )
    ),
  CONSTRAINT chk_finance_visibility_scope_permission
    CHECK (
      (
        visibility_scope = 'property_finance'
        AND required_permission_key = 'pms.finance.read'
      )
      OR (
        visibility_scope = 'affiliate_payout'
        AND required_permission_key = 'affiliate.payout.manage'
      )
      OR (
        visibility_scope = 'platform_finance'
        AND required_permission_key = 'platform.finance.read'
      )
      OR (
        visibility_scope = 'organization_finance'
        AND required_permission_key IN ('marketplace.finance.read', 'platform.finance.read')
      )
    ),
  CONSTRAINT chk_finance_visibility_scope_shape
    CHECK (
      (
        visibility_scope = 'property_finance'
        AND resource_type = 'property'
        AND property_id IS NOT NULL
        AND resource_id = property_id::text
      )
      OR (
        visibility_scope = 'organization_finance'
        AND resource_type = 'organization'
        AND property_id IS NULL
        AND resource_id = organization_id::text
      )
      OR (
        visibility_scope = 'affiliate_payout'
        AND resource_type = 'affiliate'
        AND property_id IS NULL
      )
      OR (
        visibility_scope = 'platform_finance'
        AND resource_type = 'platform'
        AND property_id IS NULL
      )
    ),
  CONSTRAINT fk_finance_visibility_property
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.properties(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_finance_visibility_permission_key
    FOREIGN KEY (required_permission_key)
    REFERENCES identity.permission_catalog(key)
);

CREATE UNIQUE INDEX uq_finance_visibility_scope_period
  ON finance.finance_visibility_read_model (
    organization_id,
    visibility_scope,
    resource_type,
    resource_id,
    COALESCE(period_start, DATE '0001-01-01'),
    COALESCE(period_end, DATE '9999-12-31'),
    currency
  );

CREATE INDEX idx_finance_visibility_property
  ON finance.finance_visibility_read_model (property_id, visibility_scope);
