-- Fixture: identity-organization-links / auth.sql
--
-- Represents the target-schema rows that the ETL transform would produce
-- from one hotel owner user in the legacy auth-db. Stable UUIDs are used
-- so parity checks can assert ID stability.
--
-- Source: auth-db.users (one hotel owner)
-- Target: identity schema tables

INSERT INTO identity.users (id, email, name, status) VALUES
  ('a1b2c3d4-0000-0000-0000-000000000001', 'owner@example.com', 'Hotel Owner', 'active');

-- WorkOS provider identity linked to the internal user.
INSERT INTO identity.external_identities
  (user_id, provider, provider_user_id, provider_email, provider_email_verified)
VALUES
  ('a1b2c3d4-0000-0000-0000-000000000001', 'workos', 'user_workos_hotel_owner', 'owner@example.com', TRUE);

-- Hotel-group organization with a WorkOS org mapping.
INSERT INTO identity.organizations
  (id, kind, name, slug, status, workos_org_id, workos_external_id)
VALUES
  ('b2c3d4e5-0000-0000-0000-000000000001', 'hotel_group', 'Hotel Alpenrose Group', 'hotel-alpenrose-group', 'active',
   'org_workos_hotel_group', 'b2c3d4e5-0000-0000-0000-000000000001');

-- Active hotel_owner membership for the user in the hotel-group org.
INSERT INTO identity.organization_memberships
  (organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs)
VALUES
  ('b2c3d4e5-0000-0000-0000-000000000001', 'a1b2c3d4-0000-0000-0000-000000000001',
   'active', 'hotel_owner', 'om_hotel_owner', ARRAY['hotel_owner']);

-- Resource links: owner of the booking hotel, operator of the PMS hotel.
INSERT INTO identity.organization_resource_links
  (organization_id, product, resource_type, resource_id, relationship, status)
VALUES
  ('b2c3d4e5-0000-0000-0000-000000000001', 'booking', 'booking_hotel', 'booking_hotel_alpenrose', 'owner',    'active'),
  ('b2c3d4e5-0000-0000-0000-000000000001', 'pms',     'pms_hotel',     'pms_hotel_alpenrose',     'operator', 'active');
