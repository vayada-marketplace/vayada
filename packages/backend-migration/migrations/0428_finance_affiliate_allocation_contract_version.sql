-- VAY-1514. Require every immutable allocation snapshot to name the accepted handoff contract.
ALTER TABLE finance.affiliate_earning_allocations
  DROP CONSTRAINT affiliate_earning_allocations_entry_snapshot_check,
  ADD CONSTRAINT affiliate_earning_allocations_entry_snapshot_check CHECK (
    (entry_snapshot->>'contractVersion' = 'finance-affiliate-settlement-entry.v1') IS TRUE
  );
