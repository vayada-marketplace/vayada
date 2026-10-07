DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='vayada_next_api_runtime'
  ) THEN
    GRANT UPDATE (resolved_at)
      ON pms.channel_operational_alerts TO vayada_next_api_runtime;
  END IF;
END;
$$;
