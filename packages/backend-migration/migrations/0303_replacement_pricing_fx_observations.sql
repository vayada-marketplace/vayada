-- Global reference observations collected by the server FX adapter, not hotel settings.
CREATE TABLE finance.pricing_v2_fx_observations (
  id TEXT PRIMARY KEY CHECK (id ~ '^exchange-rate-api:[a-f0-9]{64}$'),
  provider TEXT NOT NULL CHECK (provider='https://www.exchangerate-api.com'),
  from_currency TEXT NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency TEXT NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$' AND to_currency<>from_currency),
  numerator TEXT NOT NULL CHECK (numerator ~ '^[1-9][0-9]{0,17}$'),
  denominator TEXT NOT NULL CHECK (denominator ~ '^[1-9][0-9]{0,17}$'),
  from_scale SMALLINT NOT NULL CHECK (from_scale BETWEEN 0 AND 4),
  to_scale SMALLINT NOT NULL CHECK (to_scale BETWEEN 0 AND 4),
  observed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(observed_at)),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at) AND expires_at>observed_at AND expires_at<=observed_at+INTERVAL '24 hours'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER pricing_v2_fx_observations_immutable BEFORE UPDATE OR DELETE ON finance.pricing_v2_fx_observations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_v2_fx_observations_no_truncate BEFORE TRUNCATE ON finance.pricing_v2_fx_observations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
