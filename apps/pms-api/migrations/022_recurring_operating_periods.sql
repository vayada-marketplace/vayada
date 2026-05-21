-- Convert operating_periods from full dates (YYYY-MM-DD) to month-day only (MM-DD)
-- so they repeat every year automatically.
UPDATE room_types
SET operating_periods = (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'from', RIGHT(elem->>'from', 5),
            'to',   RIGHT(elem->>'to',   5)
        )
    ), '[]'::jsonb)
    FROM jsonb_array_elements(operating_periods) AS elem
    WHERE length(elem->>'from') = 10
      AND length(elem->>'to') = 10
)
WHERE jsonb_array_length(operating_periods) > 0
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(operating_periods) AS e
    WHERE length(e->>'from') = 10
  );
