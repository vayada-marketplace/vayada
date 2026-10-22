-- Test fixture (VAY-2276): the five ready-made roles that 0203 gave every hotel account, copied from
-- its VALUES. Since 0508 a new account gets only Account admin; suites that exercise these roles on
-- older accounts add them with this statement. $1 is a uuid[] of hotel_group organization ids.
INSERT INTO identity.organization_roles
  (organization_id, name, description, security_class, base_role_key, preset_key, default_permissions)
SELECT account.id, preset.* FROM identity.organizations account
CROSS JOIN (VALUES
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
WHERE account.id = ANY($1::uuid[]) AND account.kind = 'hotel_group'
ON CONFLICT (organization_id, preset_key) DO NOTHING
