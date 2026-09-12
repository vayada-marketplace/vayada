-- Baseline stays in source_revisions; only candidate drafts carry projected evidence.
ALTER TABLE pms.pricing_v2_drafts ADD COLUMN effective_source_revisions JSONB
  CHECK (effective_source_revisions IS NULL OR jsonb_typeof(effective_source_revisions)='object');
