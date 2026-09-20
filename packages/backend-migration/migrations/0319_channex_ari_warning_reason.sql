-- VAY-1545: classify future original receipts without rewriting historical evidence.
ALTER TABLE pms.channex_offer_ari_receipts
  ADD COLUMN warning_reason TEXT,
  ADD CONSTRAINT channex_ari_warning_reason CHECK (
    warning_reason IS NULL OR (
      outcome='complete_json' AND has_warnings AND warning_reason IN (
        'invalid_tasks','root_errors','root_warnings','invalid_meta',
        'invalid_warnings','provider_warnings'
      )
    )
  );
COMMENT ON COLUMN pms.channex_offer_ari_receipts.warning_reason IS
  'First bounded parser blocker; null means clean, non-JSON, or unclassified historical evidence. Never completion authority.';
