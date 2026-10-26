-- VAY-2232: an add-on's lead time is a fixed choice, metadata.leadTimeHours (12, 24, 48, 72 or 168;
-- null for none). This converts the free text hosts typed before (metadata.leadTime):
-- - the first "<number> <unit>" counts ("24h", "24-hour", "2 days"): minutes, hours, days or weeks,
--   also in German, Spanish, French, Dutch and Indonesian; "a day", "an hour" and "one week" count
--   one; a number without a unit counts as hours;
-- - rounded up to the next choice and capped at one week;
-- - text it can't read becomes no lead time.
-- The old text moves to metadata.legacyLeadTime, which nothing reads, so each conversion can be
-- checked and undone. Empty text is dropped. Flamur approved this on 2026-10-16 for the two
-- production values (both "<n> hours" of 12 or less, so both become 12 hours).
-- Merge only after the API and Booking Admin that read leadTimeHours (VAY-2232 P1-P4) are live: an
-- older API ignores leadTimeHours and would offer the converted add-ons with no notice.
SET LOCAL lock_timeout = '5s';

WITH legacy AS (
  SELECT id, metadata ->> 'leadTime' AS raw, lower(btrim(metadata ->> 'leadTime')) AS text
  FROM booking.addon_definitions
  WHERE jsonb_typeof(metadata -> 'leadTime') = 'string'
    AND btrim(metadata ->> 'leadTime') <> ''
    AND NOT metadata ? 'leadTimeHours'
),
parsed AS (
  SELECT id, raw,
    -- [0-9], not \d: other digits would match \d and fail the numeric cast.
    regexp_match(text, '\m(?:([0-9]+(?:[.,][0-9]+)?)[[:space:]-]*|(an?|one)[[:space:]]+)'
      || '(min|mins|minutes?|minuten?|minutos?|h|hrs?|hours?|std|stunden?|horas?|heures?|uur|jam'
      || '|d|days?|tage?|tagen|d[ií]as?|jours?|dagen?|hari'
      || '|w|wks?|weeks?|wochen?|semanas?|semaines?|weken|minggu)\M') AS m,
    CASE WHEN text ~ '^[0-9]+([.,][0-9]+)?$' THEN replace(text, ',', '.')::numeric END AS bare
  FROM legacy
),
hours AS (
  SELECT id, raw,
    CASE
      WHEN m IS NOT NULL THEN
        COALESCE(replace(m[1], ',', '.')::numeric, 1)
        * CASE
            WHEN m[3] ~ '^(min|mins|minutes?|minuten?|minutos?)$' THEN 1.0 / 60
            WHEN m[3] ~ '^(d|tag|jour|hari)' THEN 24
            WHEN m[3] ~ '^(h|std|stunde|uur|jam)' THEN 1
            ELSE 168
          END
      ELSE bare
    END AS h
  FROM parsed
)
UPDATE booking.addon_definitions addon
SET metadata = (addon.metadata - 'leadTime') || jsonb_build_object(
  'leadTimeHours',
  CASE
    WHEN hours.h IS NULL OR hours.h <= 0 THEN NULL
    WHEN hours.h <= 12 THEN 12
    WHEN hours.h <= 24 THEN 24
    WHEN hours.h <= 48 THEN 48
    WHEN hours.h <= 72 THEN 72
    ELSE 168
  END,
  'legacyLeadTime', hours.raw
)
FROM hours
WHERE addon.id = hours.id;

-- Text next to a saved choice is already ignored; keep it aside like the converted text.
UPDATE booking.addon_definitions
SET metadata = (metadata - 'leadTime') || jsonb_build_object('legacyLeadTime', metadata ->> 'leadTime')
WHERE jsonb_typeof(metadata -> 'leadTime') = 'string'
  AND btrim(metadata ->> 'leadTime') <> ''
  AND metadata ? 'leadTimeHours';

-- Empty text and JSON null mean no lead time.
UPDATE booking.addon_definitions
SET metadata = metadata - 'leadTime'
WHERE metadata ? 'leadTime'
  AND (jsonb_typeof(metadata -> 'leadTime') = 'null'
    OR (jsonb_typeof(metadata -> 'leadTime') = 'string' AND btrim(metadata ->> 'leadTime') = ''));
