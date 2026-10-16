-- Preserve token availability/provenance without rewriting historic values whose
-- source cannot be reconstructed from the old schema.
ALTER TABLE usage_history ADD COLUMN usage_input_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE usage_history ADD COLUMN usage_output_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE usage_history ADD COLUMN usage_cache_read_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE usage_history ADD COLUMN usage_cache_creation_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE usage_history ADD COLUMN usage_reasoning_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE usage_history ADD COLUMN tokens_input_source_reported INTEGER;
ALTER TABLE usage_history ADD COLUMN usage_source_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE usage_history ADD COLUMN usage_source_label TEXT NOT NULL DEFAULT 'Legacy usage row; source unavailable';
ALTER TABLE usage_history ADD COLUMN import_event_id TEXT;
ALTER TABLE usage_history ADD COLUMN usage_ingestion TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE usage_history ADD COLUMN tokens_no_cache INTEGER;
ALTER TABLE usage_history ADD COLUMN usage_no_cache_status TEXT NOT NULL DEFAULT 'legacy_unknown';

CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_import_event_id
  ON usage_history(import_event_id) WHERE import_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uh_source_timestamp
  ON usage_history(usage_source_kind, timestamp);
CREATE INDEX IF NOT EXISTS idx_uh_ingestion_timestamp
  ON usage_history(usage_ingestion, timestamp);

ALTER TABLE call_logs ADD COLUMN tokens_in_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE call_logs ADD COLUMN tokens_out_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE call_logs ADD COLUMN tokens_in_source_reported INTEGER;
ALTER TABLE call_logs ADD COLUMN usage_source_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE call_logs ADD COLUMN usage_source_label TEXT NOT NULL DEFAULT 'Legacy call log; source unavailable';
ALTER TABLE call_logs ADD COLUMN tokens_cache_read_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE call_logs ADD COLUMN tokens_cache_creation_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE call_logs ADD COLUMN tokens_reasoning_status TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE call_logs ADD COLUMN tokens_no_cache INTEGER;
ALTER TABLE call_logs ADD COLUMN tokens_no_cache_status TEXT NOT NULL DEFAULT 'legacy_unknown';
