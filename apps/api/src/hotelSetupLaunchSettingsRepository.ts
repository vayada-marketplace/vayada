import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError, resolveEffectivePropertyAccess } from "@vayada/backend-authorization";
import { withHotelSetupCommandScope } from "./hotelSetupCommandScope.js";
import { lockHotelSetupMembership } from "./hotelSetupMembership.js";
import { assertHotelSetupLaunchSettingsPrivileges } from "./hotelSetupLaunchSettingsPrivileges.js";
import { BookingContactPublicationConflictError } from "./routes/bookingSettings.js";
import type { SharedPropertyLaunchSettings } from "./routes/sharedHotelSetupStatus.js";

/** Private command SQL only. The native launch_settings migration/grants are release prerequisites.
 * No ordinary API pool or fallback is selected here. Input uses the shared route parser. */
export async function writeHotelSetupLaunchSettings(
  pool: Parameters<typeof withHotelSetupCommandScope>[0],
  context: RequestContext,
  propertyId: string,
  settings: SharedPropertyLaunchSettings,
): Promise<SharedPropertyLaunchSettings> {
  if (!context.actor.providerIdentity.sessionId) throw new AuthorizationError();
  const organizationId = context.selectedOrganization.organizationId;
  return withHotelSetupCommandScope(
    pool,
    { propertyId, organizationId, operation: "launch_settings" },
    async (client) => {
      const membership = await lockHotelSetupMembership(client, {
        organizationId,
        actorUserId: context.actor.internalUserId,
        propertyId,
      });
      const access =
        membership &&
        (await resolveEffectivePropertyAccess(membership.context, {
          async findMembershipPropertyScope() {
            return membership.scope;
          },
        }));
      if (
        !membership?.permissions.includes("hotel_catalog.setup.manage") ||
        !access?.propertyIds.includes(propertyId)
      )
        throw new AuthorizationError();

      // Serialize every settings/contact save for this property, including empty social values.
      const property = await client.query(
        "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
        [propertyId],
      );
      if (property.rows.length !== 1) throw new Error("Property launch settings unavailable");
      const locked = await client.query(
        "SELECT property_id FROM booking.booking_settings WHERE property_id=$1::uuid FOR UPDATE",
        [propertyId],
      );
      if (locked.rows.length !== 1) throw new Error("Property launch settings unavailable");
      const channels = ["instagram", "facebook", "tiktok", "youtube"] as const;
      const contacts = JSON.stringify(
        channels.map((channel_type) => ({
          channel_type,
          value: settings[channel_type],
        })),
      );
      const conflicts = await client.query(
        `SELECT contact.id FROM hotel_catalog.property_contact_channels contact
         JOIN jsonb_to_recordset($2::jsonb) input(channel_type text,value text)
           ON contact.channel_type=input.channel_type AND contact.value=input.value
         WHERE contact.property_id=$1::uuid AND contact.source_system<>'booking'
           AND NOT contact.is_public FOR UPDATE OF contact`,
        [propertyId, contacts],
      );
      if (conflicts.rows.length) throw new BookingContactPublicationConflictError();
      await client.query(
        `UPDATE booking.booking_settings SET default_currency=$2, supported_currencies=$3::text[],
          default_language=$4, supported_languages=$5::text[], updated_at=clock_timestamp()
         WHERE property_id=$1::uuid`,
        [
          propertyId,
          settings.defaultCurrency,
          settings.supportedCurrencies,
          settings.defaultLanguage,
          settings.supportedLanguages,
        ],
      );
      await client.query(
        `DELETE FROM hotel_catalog.property_contact_channels
         WHERE property_id=$1::uuid AND source_system='booking'
           AND channel_type=ANY($2::text[])`,
        [propertyId, channels],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_contact_channels
          (property_id,channel_type,value,is_public,source_system)
         SELECT $1::uuid,input.channel_type,input.value,TRUE,'booking'
         FROM jsonb_to_recordset($2::jsonb) input(channel_type text,value text)
         WHERE input.value<>''
         ON CONFLICT (property_id,channel_type,value) DO UPDATE
           SET is_public=TRUE,updated_at=clock_timestamp()
           WHERE property_contact_channels.source_system='booking'`,
        [propertyId, contacts],
      );
      // Only public contacts depend on these fields in the catalog projection. Offer cards
      // contain neither social contacts nor booking localization, so need no rebuild.
      await client.query(
        `UPDATE hotel_catalog.property_public_profile_read_model profile
         SET public_contacts=COALESCE((SELECT jsonb_agg(
           jsonb_build_object('type',channel_type,'value',value) ORDER BY channel_type,value)
           FROM hotel_catalog.property_contact_channels contact
           WHERE contact.property_id=$1::uuid AND contact.is_public),'[]'::jsonb),
           projected_at=clock_timestamp()
         WHERE profile.property_id=$1::uuid`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,organization_id,property_id,
          actor_type,actor_user_id,target_resource_product,target_resource_type,
          target_resource_id,correlation_id,redacted_payload,audit_metadata,retention_class,privacy_scope)
         VALUES ($1,'hotel_catalog','property_launch_settings_updated',clock_timestamp(),
           'property',NULL,$3::uuid,'user',$4::uuid,'hotel_catalog','property',$3::uuid::text,
           $5,'{"operation":"launch_settings"}'::jsonb,
           jsonb_build_object('actorOrganizationId',$2::uuid::text),'standard','internal')`,
        [
          randomUUID(),
          organizationId,
          propertyId,
          context.actor.internalUserId,
          context.audit.correlationId ?? context.audit.requestId,
        ],
      );
      // Read authoritative values while the transaction and native owner locks remain held.
      const saved = await client.query<SharedPropertyLaunchSettings>(
        `SELECT settings.default_currency::text AS "defaultCurrency",
          settings.supported_currencies AS "supportedCurrencies",
          settings.default_language AS "defaultLanguage",
          settings.supported_languages AS "supportedLanguages",
          ${channels
            .map(
              (channel) => `COALESCE((SELECT value
            FROM hotel_catalog.property_contact_channels WHERE property_id=$1::uuid
              AND channel_type='${channel}' AND is_public
            ORDER BY (source_system='booking') DESC,value DESC LIMIT 1),'') AS "${channel}"`,
            )
            .join(",")}
         FROM booking.booking_settings settings WHERE settings.property_id=$1::uuid`,
        [propertyId],
      );
      if (saved.rows.length !== 1) throw new Error("Property launch settings unavailable");
      return saved.rows[0]!;
    },
    assertHotelSetupLaunchSettingsPrivileges,
  );
}
