-- Generated tenant keys and tenant checks run as the native writer during
-- idempotency/audit INSERTs. Production revokes their default PUBLIC execution.
-- These immutable invoker functions grant no table access or elevated identity.
GRANT EXECUTE ON FUNCTION platform.tenant_scope_key(TEXT, UUID, UUID),
  platform.valid_tenant_scope(TEXT, UUID, UUID)
  TO vayada_next_hotel_setup_scope, vayada_next_hotel_setup_property_scope;
