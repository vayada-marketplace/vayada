-- Bank transfer bookings are created as pending requests while the guest
-- transfers funds manually. The service has supported the payment method,
-- but the bookings table check constraint still rejected the value.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_method_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_method_check
    CHECK (payment_method IN ('card', 'pay_at_property', 'xendit', 'bank_transfer'));
