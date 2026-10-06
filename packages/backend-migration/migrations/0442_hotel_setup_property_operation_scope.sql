-- VAY-1092: reserve separate native logins for currency, first-currency
-- readiness, and Owner Feature Hub commands. No login or write grant here.
ALTER TABLE platform.hotel_setup_property_scopes
  ADD COLUMN operation_class TEXT NOT NULL DEFAULT 'currency'
    CHECK (operation_class IN ('currency', 'currency_ready', 'feature_hub'));

DROP INDEX platform.hotel_setup_one_active_login_per_property;
CREATE UNIQUE INDEX hotel_setup_one_active_login_per_property_operation
  ON platform.hotel_setup_property_scopes (property_id, operation_class)
  WHERE active;

CREATE FUNCTION platform.hotel_setup_property_operation_allowed(
  requested_property_id UUID, requested_operation_class TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF requested_operation_class NOT IN ('currency', 'currency_ready', 'feature_hub')
    OR NOT platform.hotel_setup_property_allowed(requested_property_id)
  THEN RETURN FALSE; END IF;

  RETURN EXISTS (
    SELECT 1 FROM platform.hotel_setup_property_scopes scope
    WHERE scope.database_login = session_user
      AND scope.property_id = requested_property_id
      AND scope.operation_class = requested_operation_class
      AND scope.active
    FOR SHARE OF scope
  );
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_operation_allowed(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_operation_allowed(UUID, TEXT)
  TO vayada_next_hotel_setup_property_scope;

-- A Feature Hub login may read its property to authorize a toggle, but cannot
-- save currency or categories even if a later grant accidentally permits it.
DROP POLICY hotel_setup_property_currency_scope ON pms.property_pricing_settings;
CREATE POLICY hotel_setup_property_currency_scope ON pms.property_pricing_settings
  AS RESTRICTIVE TO vayada_next_hotel_setup_property_scope
  USING (
    platform.hotel_setup_property_operation_allowed(property_id, 'currency')
    OR platform.hotel_setup_property_operation_allowed(property_id, 'currency_ready')
  )
  WITH CHECK (
    platform.hotel_setup_property_operation_allowed(property_id, 'currency')
    OR platform.hotel_setup_property_operation_allowed(property_id, 'currency_ready')
  );

DROP POLICY hotel_setup_property_category_scope ON finance.expense_categories;
CREATE POLICY hotel_setup_property_category_scope ON finance.expense_categories
  AS RESTRICTIVE TO vayada_next_hotel_setup_property_scope
  USING (
    platform.hotel_setup_property_operation_allowed(property_id, 'currency')
    OR platform.hotel_setup_property_operation_allowed(property_id, 'currency_ready')
  )
  WITH CHECK (
    platform.hotel_setup_property_operation_allowed(property_id, 'currency')
    OR platform.hotel_setup_property_operation_allowed(property_id, 'currency_ready')
  );
