CREATE FUNCTION pms.resolve_verified_channex_alert(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE pms.channel_operational_alerts alert SET resolved_at=now()
  WHERE alert.resolved_at IS NULL AND p_job_id=ANY(alert.recovery_jobs)
    AND cardinality(alert.recovery_jobs)>0 AND alert.last_occurred_at<=alert.recovery_started_at
    AND EXISTS(SELECT 1 FROM pms.channel_connections connection
      WHERE connection.id=alert.connection_id
        AND connection.binding_generation=alert.binding_generation)
    AND NOT EXISTS(
      SELECT 1 FROM unnest(alert.recovery_jobs) AS linked(job_id)
      LEFT JOIN platform.jobs job ON job.id=linked.job_id
      WHERE job.id IS NULL OR job.status<>'succeeded'
        OR job.job_metadata->>'alertRecoveryVerified' IS DISTINCT FROM 'true'
    );
END;
$$;

REVOKE ALL ON FUNCTION pms.resolve_verified_channex_alert(uuid) FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'vayada_next_api_runtime',
    'vayada_next_channex_management_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION pms.resolve_verified_channex_alert(uuid) TO %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;
