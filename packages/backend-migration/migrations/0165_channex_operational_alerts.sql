CREATE TABLE pms.channel_operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES hotel_catalog.properties(id),
  connection_id uuid NOT NULL REFERENCES pms.channel_connections(id),
  binding_generation uuid NOT NULL,
  problem_key text NOT NULL,
  event_type text NOT NULL,
  impact jsonb NOT NULL DEFAULT '{}',
  first_occurred_at timestamptz NOT NULL,
  last_occurred_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES identity.users(id),
  resolved_at timestamptz,
  recovery_jobs uuid[] NOT NULL DEFAULT '{}',
  recovery_started_at timestamptz,
  recovery_round integer NOT NULL DEFAULT 0 CHECK (recovery_round BETWEEN 0 AND 3),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channel_operational_alerts_open_problem
  ON pms.channel_operational_alerts(connection_id, binding_generation, problem_key)
  WHERE resolved_at IS NULL;
CREATE INDEX channel_operational_alerts_property ON pms.channel_operational_alerts(property_id, last_occurred_at DESC);
CREATE TABLE pms.channel_operational_alert_occurrences (
  receipt_id uuid PRIMARY KEY REFERENCES platform.external_webhook_events(id),
  alert_id uuid NOT NULL REFERENCES pms.channel_operational_alerts(id),
  occurred_at timestamptz NOT NULL,
  last_delivered_at timestamptz NOT NULL DEFAULT now(),
  deliveries integer NOT NULL DEFAULT 1
);
