-- VAY-2017: coordinated release applies owner admission 0213 before this migration.
-- Preserve owner/setup contracts; admit only the separately signed transition.
ALTER TABLE platform.legacy_owner_approval_records
  DROP CONSTRAINT legacy_owner_approval_records_contract_version_check,
  ADD CONSTRAINT legacy_owner_approval_records_contract_version_check
    CHECK (contract_version IN ('legacy-pms-owner-evidence.v1',
      'legacy-owner-internal-setup.v1', 'legacy-historical-binding-transition.v1'));
