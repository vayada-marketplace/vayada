-- VAY-1362: the approved legacy migration cohort, written once per source run by the
-- cutover orchestrator (engineering/legacy-migration-cohort-scope.md, "Input").
-- Platform-only evidence: no grants, and no RLS policy or trigger on identity or catalog.
CREATE FUNCTION platform.production_migration_cohort_ids_valid(ids UUID[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT coalesce(array_ndims(ids), 1) = 1
     AND array_position(ids, NULL) IS NULL
     AND ids = ARRAY(SELECT DISTINCT id FROM unnest(ids) AS id ORDER BY id)
$$;

CREATE TABLE platform.production_migration_cohorts (
  source_run_id         TEXT        PRIMARY KEY CHECK (source_run_id ~ '^vay1351-[0-9a-f]{24}$'),
  cohort_sha256         TEXT        NOT NULL CHECK (cohort_sha256 ~ '^[0-9a-f]{64}$'),
  booking_hotel_ids     UUID[]      NOT NULL
                                    CHECK (cardinality(booking_hotel_ids) > 0
                                      AND platform.production_migration_cohort_ids_valid(booking_hotel_ids)),
  pms_hotel_ids         UUID[]      NOT NULL
                                    CHECK (platform.production_migration_cohort_ids_valid(pms_hotel_ids)),
  marketplace_hotel_ids UUID[]      NOT NULL
                                    CHECK (platform.production_migration_cohort_ids_valid(marketplace_hotel_ids)),
  approval_proof_sha256 TEXT        NOT NULL CHECK (approval_proof_sha256 ~ '^[0-9a-f]{64}$'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER production_migration_cohorts_append_only
  BEFORE UPDATE OR DELETE ON platform.production_migration_cohorts
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER production_migration_cohorts_no_truncate
  BEFORE TRUNCATE ON platform.production_migration_cohorts
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
REVOKE ALL ON platform.production_migration_cohorts FROM PUBLIC;

-- The cutover run records the cohort it was configured with (NULL: no cohort).
ALTER TABLE platform.production_cutover_runs
  ADD COLUMN cohort_sha256 TEXT CHECK (cohort_sha256 ~ '^[0-9a-f]{64}$');
