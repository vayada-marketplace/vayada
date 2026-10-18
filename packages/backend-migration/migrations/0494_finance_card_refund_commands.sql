-- VAY-2205: automatic card refunds of pricing-v2 bookings (Phase 1, dark until a hotel takes card).
-- A cancel records one command here in its own transaction; the refund is then asked of Stripe with
-- the command's idempotency key, and the original payment, a refund payment row and the booking
-- change only once Stripe says it succeeded. A pending command is never money received: balance
-- sums over finance.payments don't see it.
-- Flamur approved this guard on 2026-10-18 (Q15): at most one refund that hasn't failed per card
-- payment, so a guest and a hotel cancelling at the same moment can never both refund.
SET LOCAL lock_timeout = '5s';

CREATE TABLE finance.card_refund_commands (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id UUID NOT NULL,
  payment_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('guest', 'host')),
  amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
  provider_account_ref TEXT NOT NULL CHECK (provider_account_ref LIKE 'acct\_%'),
  provider_payment_intent_id TEXT NOT NULL CHECK (provider_payment_intent_id LIKE 'pi\_%'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_refund_id TEXT UNIQUE CHECK (provider_refund_id LIKE 're\_%'),
  provider_status TEXT,
  failure_reason TEXT CHECK (length(failure_reason) <= 500),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  CONSTRAINT fk_card_refund_commands_payment
    FOREIGN KEY (payment_id, property_id, guest_booking_id)
    REFERENCES finance.payments(id, property_id, guest_booking_id),
  CONSTRAINT chk_card_refund_commands_settled
    CHECK ((status = 'pending') = (settled_at IS NULL)),
  CONSTRAINT chk_card_refund_commands_succeeded
    CHECK (status <> 'succeeded' OR provider_refund_id IS NOT NULL)
);

CREATE UNIQUE INDEX card_refund_commands_one_live_per_payment
  ON finance.card_refund_commands(payment_id) WHERE status <> 'failed';
CREATE INDEX card_refund_commands_due
  ON finance.card_refund_commands(next_attempt_at) WHERE status = 'pending';
CREATE INDEX card_refund_commands_booking
  ON finance.card_refund_commands(property_id, guest_booking_id);

COMMENT ON TABLE finance.card_refund_commands IS
  'Finance-owned automatic card refunds of pricing-v2 bookings (VAY-2205); pending rows are not money.';
