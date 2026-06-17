-- Disabled last-minute discounts must not retain tiers. Some downstream
-- read models inspect pricing tiers independently, so keep the stored OFF
-- shape unambiguous.

UPDATE hotels
SET last_minute_discount = '{"enabled": false, "stackWithPromo": false, "tiers": []}'::jsonb
WHERE last_minute_discount IS NOT NULL
  AND last_minute_discount ->> 'enabled' IS DISTINCT FROM 'true';

UPDATE room_types
SET last_minute_discount = '{"enabled": false, "stackWithPromo": false, "tiers": []}'::jsonb
WHERE last_minute_discount IS NOT NULL
  AND last_minute_discount ->> 'enabled' IS DISTINCT FROM 'true';
