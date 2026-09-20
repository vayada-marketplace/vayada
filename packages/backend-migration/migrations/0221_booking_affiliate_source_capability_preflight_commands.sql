-- VAY-1506. Command retry identity for authenticated source-capability preflights.
-- Existing storage-only rows remain historical evidence but cannot be replayed as commands.
ALTER TABLE booking.affiliate_source_capability_production_preflights
  ADD COLUMN command_key_hash TEXT,
  ADD COLUMN request_fingerprint_hash TEXT,
  ADD CONSTRAINT chk_affiliate_source_preflight_command_identity CHECK (
    (command_key_hash IS NULL AND request_fingerprint_hash IS NULL)
    OR (
      command_key_hash IS NOT NULL
      AND request_fingerprint_hash IS NOT NULL
      AND command_key_hash ~ '^[a-f0-9]{64}$'
      AND request_fingerprint_hash ~ '^[a-f0-9]{64}$'
    )
  );

CREATE UNIQUE INDEX uq_affiliate_source_preflight_command
  ON booking.affiliate_source_capability_production_preflights(property_id, command_key_hash)
  WHERE command_key_hash IS NOT NULL;

COMMENT ON COLUMN booking.affiliate_source_capability_production_preflights.command_key_hash IS
  'Server-hashed retry identity for an authorized source-capability preflight; absent on storage-only historical rows.';
