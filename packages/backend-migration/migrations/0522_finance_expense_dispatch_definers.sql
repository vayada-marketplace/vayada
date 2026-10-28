-- VAY-2108 W2d: the API login writes OTA commission and provider fee evidence, and their AFTER
-- INSERT triggers (0099) queue the Finance worker's discovery rows. finance.expense_generation_dispatches
-- is worker-only state the API login may not write (VAY-2054 product-DML posture), so with
-- invoker rights every Channex OTA booking with nightly prices failed with 42501 on that login.
-- The two trigger functions now run as their owner, like 0458's guard: same bodies, a pinned
-- search_path, and no EXECUTE for anyone (a trigger fires without it). They insert only the
-- discovery row of the evidence row the caller has just been allowed to insert.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION finance.dispatch_ota_commission_expense_generation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN INSERT INTO finance.expense_generation_dispatches(family,evidence_id,property_id,created_at,run_after)
  VALUES('ota_commission',NEW.id,NEW.property_id,NEW.created_at,'-infinity') ON CONFLICT DO NOTHING; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION finance.dispatch_ota_commission_expense_generation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION finance.dispatch_provider_fee_expense_generation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN INSERT INTO finance.expense_generation_dispatches(family,evidence_id,property_id,payment_id,created_at,run_after)
  VALUES('provider_fee',NEW.id,NEW.property_id,NEW.payment_id,NEW.created_at,'-infinity') ON CONFLICT DO NOTHING; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION finance.dispatch_provider_fee_expense_generation() FROM PUBLIC;
