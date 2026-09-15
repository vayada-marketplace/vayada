-- VAY-1439: Initialize presets once; leave all existing member/invitation access untouched.
-- A conflicting custom role name aborts the migration instead of overwriting it.
CREATE FUNCTION identity.initialize_team_role_presets(organization UUID)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO identity.organization_roles
    (organization_id, name, description, security_class, base_role_key, preset_key, default_permissions)
  SELECT account.id, preset.* FROM identity.organizations account
  CROSS JOIN (VALUES
    ('Account admin', 'Full access to every property, every section and billing.', 'account_admin', 'hotel_owner', 'account_admin', '[]'::jsonb),
    ('Agency manager', 'Manages workers and properties within their own access. Cannot change billing or transfer admin.', 'staff', 'hotel_manager', 'agency_manager',
     '["pms.dashboard.read","pms.dashboard.operations.read","pms.dashboard.finance.read","pms.calendar.read","pms.calendar.manage","pms.reservation.read","pms.reservation.update","pms.reservation.cancel","pms.guest_contact.read","pms.inbox.read","pms.inbox.reply","pms.room_status.read","pms.rooms_rates.read","pms.rooms_rates.manage","pms.finance.read","pms.channel_manager.read","pms.settings.read","pms.settings.manage","identity.staff.manage","booking.analytics.read","booking.design.read","booking.design.manage","booking.flow.read","booking.flow.manage","booking.settings.read","booking.settings.manage","booking.addons.read","booking.addons.manage","booking.promos.read","booking.promos.manage"]'::jsonb),
    ('Property owner', 'Read-only performance and financial information for assigned properties.', 'external_owner', 'external_owner', 'property_owner',
     '["pms.dashboard.read","pms.dashboard.operations.read","pms.dashboard.finance.read","pms.calendar.read","pms.reservation.read","pms.room_status.read","pms.rooms_rates.read","pms.finance.read","booking.analytics.read"]'::jsonb),
    ('Reservation manager', 'Runs bookings, calendar, guest messages and room rates.', 'staff', 'hotel_custom', 'reservation_manager',
     '["pms.dashboard.read","pms.dashboard.operations.read","pms.calendar.read","pms.calendar.manage","pms.reservation.read","pms.reservation.update","pms.reservation.cancel","pms.guest_contact.read","pms.inbox.read","pms.inbox.reply","pms.room_status.read","pms.rooms_rates.read","pms.rooms_rates.manage","pms.finance.read","pms.channel_manager.read"]'::jsonb),
    ('Front desk', 'Handles arrivals, check-in, check-out and guest messages.', 'staff', 'front_desk', 'front_desk',
     '["pms.dashboard.read","pms.dashboard.operations.read","pms.calendar.read","pms.reservation.read","pms.reservation.update","pms.guest_contact.read","pms.inbox.read","pms.inbox.reply","pms.room_status.read"]'::jsonb),
    ('Housekeeping', 'Views arrivals, departures and room status without guest contact details.', 'housekeeping', 'housekeeping', 'housekeeping',
     '["pms.dashboard.read","pms.calendar.read","pms.room_status.read"]'::jsonb)
  ) AS preset(name, description, security_class, base_role_key, preset_key, default_permissions)
  WHERE account.id = organization AND account.kind = 'hotel_group'
  ON CONFLICT (organization_id, preset_key) DO NOTHING;
$$;

CREATE FUNCTION identity.initialize_new_account_team_roles()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM identity.initialize_team_role_presets(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER initialize_new_account_team_roles
AFTER INSERT ON identity.organizations
FOR EACH ROW WHEN (NEW.kind = 'hotel_group')
EXECUTE FUNCTION identity.initialize_new_account_team_roles();

-- Install the trigger first: its table lock closes the concurrent account-creation gap.
SELECT identity.initialize_team_role_presets(id) FROM identity.organizations WHERE kind = 'hotel_group';

-- Roles belong to their account. Direct admin-role deletion stays forbidden;
-- deleting the account itself may clean up its now-orphaned immutable role.
ALTER TABLE identity.organization_roles DROP CONSTRAINT organization_roles_organization_id_fkey;
ALTER TABLE identity.organization_roles ADD CONSTRAINT organization_roles_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES identity.organizations(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION identity.protect_role_definition_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM identity.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.security_class = 'account_admin' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account admin role is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF ROW(NEW.organization_id, NEW.security_class, NEW.base_role_key, NEW.preset_key)
     IS DISTINCT FROM ROW(OLD.organization_id, OLD.security_class, OLD.base_role_key, OLD.preset_key) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'role identity and security class are immutable';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
