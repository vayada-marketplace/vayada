import { createHash } from "node:crypto";
import { AuthorizationError } from "@vayada/backend-authorization";
import type pg from "pg";
import { syncPropertyOfferReadModels } from "../routes/marketplaceAdmin.js";
import type {
  HotelSetupPropertyProfileCommand,
  HotelSetupPropertyProfileResult,
} from "../routes/sharedHotelSetupStatus.js";
import {
  propertyProfileWritePayload,
  toSharedPropertyProfile,
  type SharedPropertyProfileRow,
} from "./sharedHotelSetupStatusReadModel.js";

type ProfileScope = { propertyId: string; organizationId: string; actorUserId: string };
type Client = Pick<pg.PoolClient, "query">;

const OPERATION = "hotel_setup_property_profile_update";

/** Same row shape as platform.hotel_setup_property_profile_row (migration 0470). */
const PROFILE_ROW = `SELECT jsonb_build_object(
    'propertyId', property.id::text, 'profileRevision', property.profile_revision,
    'displayName', NULLIF(property.display_name, ''), 'propertyType', NULLIF(property.property_type, ''),
    'countryCode', NULLIF(location.country_code::text, ''), 'city', NULLIF(location.city, ''),
    'streetAddress', NULLIF(location.street_address, ''), 'postalCode', NULLIF(location.postal_code, ''),
    'timezone', NULLIF(location.timezone, ''), 'latitude', location.latitude, 'longitude', location.longitude,
    'localityPublic', COALESCE(location.address_public, FALSE), 'geoPublic', COALESCE(location.geo_public, FALSE),
    'mapDisplayMode', COALESCE(location.map_display_mode, 'hidden'),
    'contacts', COALESCE((SELECT jsonb_agg(jsonb_build_object('channelType', contact.channel_type,
        'value', contact.value, 'purpose', contact.purpose, 'isPublic', contact.is_public)
        ORDER BY contact.channel_type, contact.value, contact.created_at, contact.id)
      FROM hotel_catalog.property_contact_channels contact WHERE contact.property_id = property.id
        AND (contact.source_system = 'platform' OR (contact.is_public
          AND contact.channel_type IN ('phone', 'whatsapp', 'email')))), '[]'::jsonb)) AS value
  FROM hotel_catalog.properties property
  LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
  WHERE property.id = $1::uuid`;

/** The parameterised half of platform.hotel_setup_profile_authority (0470): the original Owner
 * shape, re-locked in this transaction. The organization FOR UPDATE serializes concurrent edits
 * and revocation exactly as the native writer did. */
async function lockProfileAuthority(client: Client, scope: ProfileScope): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `WITH organization AS (
       SELECT id FROM identity.organizations
       WHERE id=$2::uuid AND kind='hotel_group' AND status='active' FOR UPDATE),
     member AS (
       SELECT membership.* FROM identity.organization_memberships membership, organization
       WHERE membership.organization_id=organization.id AND membership.user_id=$3::uuid
         AND membership.status='active' FOR SHARE OF membership)
     SELECT EXISTS (SELECT 1 FROM member
       WHERE member.role_key='hotel_owner'
         AND (member.permission_overrides IS NULL OR member.permission_overrides='{"grant":[],"deny":[]}'::jsonb)
         AND (member.role_definition_id IS NULL OR EXISTS (SELECT 1 FROM identity.organization_roles role
           WHERE role.id=member.role_definition_id AND role.organization_id=member.organization_id
             AND role.security_class='account_admin' AND role.base_role_key='hotel_owner'
             AND role.preset_key='account_admin' AND role.default_permissions='[]'::jsonb FOR SHARE))
         AND EXISTS (SELECT 1 FROM identity.role_permission_grants permission
           WHERE permission.organization_kind='hotel_group' AND permission.role_key='hotel_owner'
             AND permission.permission_key='hotel_catalog.setup.manage' FOR SHARE)
         AND EXISTS (SELECT 1 FROM identity.role_permission_grants permission
           WHERE permission.organization_kind='hotel_group' AND permission.role_key='hotel_owner'
             AND permission.permission_key='marketplace.profile.manage' FOR SHARE)
         AND EXISTS (SELECT 1 FROM identity.users actor
           WHERE actor.id=member.user_id AND actor.status='active' FOR SHARE)
         AND (member.property_access_mode='all' OR (member.property_access_mode='assigned'
           AND EXISTS (SELECT 1 FROM identity.membership_property_assignments assignment
             WHERE assignment.membership_id=member.id AND assignment.property_id=$1::uuid FOR SHARE)))
         AND EXISTS (SELECT 1 FROM identity.organization_resource_links owner_link
           JOIN hotel_catalog.properties property ON property.id=$1::uuid AND property.lifecycle_status<>'retired'
           WHERE owner_link.organization_id=member.organization_id AND owner_link.product='hotel_catalog'
             AND owner_link.resource_type='property' AND lower(owner_link.resource_id)=$1::uuid::text
             AND owner_link.relationship='owner' AND owner_link.status='active'
           FOR SHARE OF owner_link, property)) AS allowed`,
    [scope.propertyId, scope.organizationId, scope.actorUserId],
  );
  return result.rows[0]?.allowed === true;
}

async function profileRow(client: Client, propertyId: string) {
  const result = await client.query<{ value: SharedPropertyProfileRow }>(PROFILE_ROW, [propertyId]);
  const row = result.rows[0]?.value;
  if (!row) throw new Error("Hotel setup profile property missing");
  return row;
}

/** Ordinary-login port of platform.hotel_setup_update_property_profile (migration 0472):
 * one READ COMMITTED transaction with authority, replay, revision CAS, contact privacy,
 * profile/location/contact writes, read models, idempotency key and audit. */
export async function writeOrdinaryHotelSetupPropertyProfile(
  pool: Pick<pg.Pool, "connect">,
  scope: ProfileScope,
  correlation: string,
  command: HotelSetupPropertyProfileCommand,
): Promise<HotelSetupPropertyProfileResult> {
  const keyHash = createHash("sha256").update(command.idempotencyKey).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    if (!(await lockProfileAuthority(client, scope))) throw new AuthorizationError();
    const replay = await client.query<{ fingerprint: string }>(
      `SELECT request_fingerprint_hash AS fingerprint FROM platform.idempotency_keys
       WHERE operation_scope='hotel_catalog' AND operation=$1 AND tenant_scope='property'
         AND property_id=$2::uuid AND key_hash=$3 FOR UPDATE`,
      [OPERATION, scope.propertyId, keyHash],
    );
    if (replay.rows[0]) {
      const result: HotelSetupPropertyProfileResult =
        replay.rows[0].fingerprint === command.fingerprint
          ? {
              status: "replayed",
              profile: toSharedPropertyProfile(await profileRow(client, scope.propertyId)),
            }
          : { status: "idempotency_conflict" };
      await client.query("ROLLBACK");
      return result;
    }
    const before = await profileRow(client, scope.propertyId);
    const update = command.merge(toSharedPropertyProfile(before).profile);
    if ("fields" in update) {
      await client.query("ROLLBACK");
      return { status: "invalid", fields: update.fields };
    }
    const current = await client.query<{ revision: string }>(
      "SELECT profile_revision AS revision FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
      [scope.propertyId],
    );
    const currentRevision = Number(current.rows[0]?.revision);
    if (currentRevision !== update.expectedProfileRevision) {
      await client.query("ROLLBACK");
      return { status: "conflict", currentRevision };
    }
    const payload = JSON.stringify(propertyProfileWritePayload(update.profile));
    // Never publish or re-own a contact the profile does not show (private or another product's).
    const hidden = await client.query(
      `SELECT 1 FROM hotel_catalog.property_contact_channels contact
       JOIN jsonb_to_recordset($2::jsonb->'contacts') input(channel_type text, value text)
         ON input.channel_type=contact.channel_type AND input.value=contact.value
       WHERE contact.property_id=$1::uuid AND contact.source_system<>'platform'
         AND NOT (contact.is_public AND contact.channel_type IN ('phone','whatsapp','email'))`,
      [scope.propertyId, payload],
    );
    if (hidden.rows.length) {
      await client.query("ROLLBACK");
      return { status: "private_contact_conflict" };
    }
    await client.query(
      `UPDATE hotel_catalog.properties SET display_name=$2::jsonb->>'display_name',
         property_type=$2::jsonb->>'property_type', profile_revision=profile_revision+1, updated_at=now()
       WHERE id=$1::uuid AND profile_revision=$3`,
      [scope.propertyId, payload, update.expectedProfileRevision],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, country_code, city, street_address,
         postal_code, latitude, longitude, timezone, address_public, geo_public, map_display_mode,
         source_confidence, updated_at)
       SELECT $1::uuid, NULLIF(input.country_code,'')::char(2), input.city, input.street_address,
         input.postal_code, input.latitude, input.longitude, input.timezone, input.address_public,
         input.geo_public, COALESCE(input.map_display_mode,'hidden'), 'verified', now()
       FROM jsonb_to_record($2::jsonb) AS input(country_code text, city text, street_address text,
         postal_code text, timezone text, latitude numeric, longitude numeric, address_public boolean,
         geo_public boolean, map_display_mode text)
       ON CONFLICT (property_id) DO UPDATE SET country_code=EXCLUDED.country_code, city=EXCLUDED.city,
         street_address=EXCLUDED.street_address, postal_code=EXCLUDED.postal_code,
         latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude, timezone=EXCLUDED.timezone,
         address_public=EXCLUDED.address_public, geo_public=EXCLUDED.geo_public,
         map_display_mode=EXCLUDED.map_display_mode, source_confidence=EXCLUDED.source_confidence,
         updated_at=now()`,
      [scope.propertyId, payload],
    );
    await client.query(
      `DELETE FROM hotel_catalog.property_contact_channels contact
       WHERE contact.property_id=$1::uuid AND contact.source_system='platform'
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb->'contacts') input(channel_type text, value text)
           WHERE input.channel_type=contact.channel_type AND input.value=contact.value)`,
      [scope.propertyId, payload],
    );
    await client.query(
      `DELETE FROM hotel_catalog.property_contact_channels
       WHERE property_id=$1::uuid AND source_system<>'platform' AND is_public
         AND channel_type IN ('phone','whatsapp','email')`,
      [scope.propertyId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_contact_channels (property_id, channel_type, value, purpose,
         is_public, source_system, updated_at)
       SELECT $1::uuid, input.channel_type, input.value, input.purpose, input.is_public, 'platform', now()
       FROM jsonb_to_recordset($2::jsonb->'contacts') input(channel_type text, value text, purpose text, is_public boolean)
       ON CONFLICT (property_id, channel_type, value) DO UPDATE SET purpose=EXCLUDED.purpose,
         is_public=EXCLUDED.is_public, source_system=EXCLUDED.source_system, updated_at=now()`,
      [scope.propertyId, payload],
    );
    await syncPropertyOfferReadModels(client, { propertyId: scope.propertyId });
    const after = await profileRow(client, scope.propertyId);
    const changed = Object.keys(after)
      .filter((key) => key !== "propertyId" && key !== "profileRevision")
      .filter(
        (key) =>
          JSON.stringify(after[key as keyof SharedPropertyProfileRow]) !==
          JSON.stringify(before[key as keyof SharedPropertyProfileRow]),
      )
      .sort();
    const key = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys (operation_scope, operation, key_hash, request_fingerprint_hash,
         status, tenant_scope, property_id, response_status_code, response_resource_product,
         response_resource_type, response_resource_id, correlation_id, completed_at, expires_at)
       VALUES ('hotel_catalog', $1, $2, $3, 'completed', 'property', $4::uuid, 200, 'hotel_catalog',
         'property', $4::uuid::text, $5, now(), now() + interval '30 days') RETURNING id::text`,
      [OPERATION, keyHash, command.fingerprint, scope.propertyId, correlation],
    );
    const keyId = key.rows[0]!.id;
    await client.query(
      `INSERT INTO platform.product_audit_events (audit_key, product, action, occurred_at, tenant_scope,
         property_id, actor_type, actor_user_id, target_resource_product, target_resource_type,
         target_resource_id, correlation_id, idempotency_key_id, redacted_payload, audit_metadata,
         retention_class, privacy_scope)
       VALUES ('hotel_setup_property_profile:' || $1, 'hotel_catalog', 'property_profile_updated',
         clock_timestamp(), 'property', $2::uuid, 'user', $3::uuid, 'hotel_catalog', 'property',
         $2::uuid::text, $4, $1::uuid,
         jsonb_build_object('operation','property_profile','changedFields',$5::jsonb,'profileRevision',$6::bigint),
         jsonb_build_object('actorOrganizationId',$7::uuid::text), 'standard', 'internal')`,
      [
        keyId,
        scope.propertyId,
        scope.actorUserId,
        correlation,
        JSON.stringify(changed),
        Number(after.profileRevision),
        scope.organizationId,
      ],
    );
    await client.query("COMMIT");
    return { status: "updated", profile: toSharedPropertyProfile(after) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
