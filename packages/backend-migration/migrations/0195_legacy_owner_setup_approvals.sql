-- VAY-2017: admit only the separately signed internal-setup operation.
-- No grants, new principals, approval rows or account writes.
ALTER TABLE platform.legacy_owner_approval_records
  DROP CONSTRAINT legacy_owner_approval_records_contract_version_check,
  ADD CONSTRAINT legacy_owner_approval_records_contract_version_check
    CHECK (contract_version IN ('legacy-pms-owner-evidence.v1', 'legacy-owner-internal-setup.v1'));
