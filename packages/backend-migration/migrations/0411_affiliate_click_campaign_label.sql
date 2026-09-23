-- VAY-1506. Optional advisory share label; beneficiary remains fixed by the link.
ALTER TABLE marketplace.affiliate_click_occurrences
  ADD COLUMN campaign_label TEXT
    CHECK (campaign_label ~ '^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$');
