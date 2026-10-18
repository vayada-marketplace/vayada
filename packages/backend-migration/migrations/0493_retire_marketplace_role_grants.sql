-- VAY-2270 (Marketplace removal step 3b). HOLD: merge only with Flamur's yes, and only after the
-- API that no longer accepts marketplace.profile.manage for hotel setup is live (#3407).
--
-- No role holds a Marketplace or affiliate permission any more: hotel owners lose the grants
-- 0002, 0018, 0087 gave them (collaboration read/write/review, profile manage, affiliate manage),
-- and the creator and affiliate organization kinds lose every grant. The catalog keys stay until
-- the Marketplace data is deleted (step 5): finance.finance_visibility_read_model still names
-- marketplace.finance.read and affiliate.payout.manage in a CHECK and a foreign key.
SET LOCAL lock_timeout = '5s';

DELETE FROM identity.role_permission_grants grant_row
USING identity.permission_catalog catalog
WHERE catalog.key = grant_row.permission_key
  AND catalog.product IN ('marketplace', 'affiliate');

DELETE FROM identity.role_permission_grants
WHERE organization_kind IN ('creator_workspace', 'affiliate_partner');
