-- VAY-1504. Build the composite keys without blocking existing agreement writes.
-- vayada:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS marketplace.uq_affiliate_agreement_link_scope;

-- vayada:next-statement
CREATE UNIQUE INDEX CONCURRENTLY uq_affiliate_agreement_link_scope
  ON marketplace.affiliate_agreements (id, participation_id, program_id, property_id);

-- vayada:next-statement
DROP INDEX CONCURRENTLY IF EXISTS marketplace.uq_affiliate_activation_link_scope;

-- vayada:next-statement
CREATE UNIQUE INDEX CONCURRENTLY uq_affiliate_activation_link_scope
  ON marketplace.affiliate_agreement_activations (id, agreement_id);
