-- Migration: 0515_payment_method_booking_windows
-- Owner: domain-finance (settings) and domain-booking (checkout) / VAY-2348
--
-- Booking windows per payment method (Booking Admin › Payments): a hotel offers card, pay at the property or bank
-- transfer only to guests who book at least N days before arrival, or within N hours/days of arrival. Lead times
-- count to the hotel's check-in time in its own time zone; a day is 24 hours. No row means no limit, so every
-- hotel is unchanged at release.
--
-- Its own table, not a finance.payment_settings column: the pricing-v2 Finance source hashes that whole row, so a
-- new column would stale every hotel's published prices, and a window doesn't change any price. Quote, booking and
-- the checkout settings read it live.
--
-- Bank transfer keeps its fixed 48-hour payment deadline, and checks here keep its window longer than that:
-- "at least" 3 days or more, "within" more than 48 hours. PayPal has no booking window.

CREATE TABLE finance.payment_method_booking_windows (
  property_id    UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  payment_method TEXT        NOT NULL CHECK (payment_method IN ('card', 'pay_at_property', 'bank_transfer')),
  window_kind    TEXT        NOT NULL CHECK (window_kind IN ('at_least', 'within')),
  amount         INTEGER     NOT NULL CHECK (amount >= 1),
  unit           TEXT        NOT NULL CHECK (unit IN ('hours', 'days')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, payment_method),
  CONSTRAINT payment_method_booking_window_at_least_days CHECK (window_kind <> 'at_least' OR unit = 'days'),
  CONSTRAINT payment_method_booking_window_up_to_a_year
    CHECK (amount <= CASE unit WHEN 'days' THEN 365 ELSE 8760 END),
  CONSTRAINT payment_method_booking_window_bank_transfer_deadline CHECK (
    payment_method <> 'bank_transfer'
    OR (window_kind = 'at_least' AND amount >= 3)
    OR (window_kind = 'within' AND amount * CASE unit WHEN 'days' THEN 24 ELSE 1 END > 48)
  )
);

COMMENT ON TABLE finance.payment_method_booking_windows IS
  'VAY-2348: when each payment method is offered, by how long before check-in the guest books. No row: no limit.';
