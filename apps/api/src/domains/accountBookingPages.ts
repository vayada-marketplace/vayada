import { randomUUID } from "node:crypto";

import {
  defaultAccountBookingPageSettings,
  parseAccountBookingPageSlug,
  readAccountBookingPageSettings,
  suggestAccountBookingPageSlug,
  type AccountBookingPageSettings,
  type AccountBookingPageUpdate,
} from "@vayada/domain-booking";
import pg, { type PoolClient } from "pg";

import {
  activeBookingPublicationGateConfig,
  visibleActiveBookingPublication,
} from "./activeBookingPublicationGate.js";

/** What keeps a property off the agency page: no visible booking page, no property type, no map pin. */
export type AccountBookingPageMissing = "setup" | "type" | "location";

export type AccountBookingPageProperty = {
  propertyId: string;
  name: string;
  propertyType: string | null;
  area: string | null;
  /** The published booking page's hero image, else its first room photo (Booking Admin's list). */
  photoUrl: string | null;
  /** Rooms or villas in the PMS, retired ones left out. */
  units: number;
  /** Ready to show guests: a visible booking page, a property type and a map location. */
  ready: boolean;
  missing: AccountBookingPageMissing[];
  included: boolean;
};

export type AccountBookingPageSummary = {
  /** False until something was saved; then `page` holds the defaults and revision 0. */
  saved: boolean;
  page: {
    slug: string;
    live: boolean;
    revision: number;
    settings: AccountBookingPageSettings;
    /** Included properties of the account in their "Recommended" order. */
    propertyIds: string[];
  };
  defaults: AccountBookingPageSettings;
  /** Every property of the account, by name. */
  properties: AccountBookingPageProperty[];
  /** Only accounts with two or more active properties can create a page or turn it live. */
  canSave: boolean;
};

export type AccountBookingPageSaveError =
  | "account_not_found"
  | "page_changed"
  | "slug_taken"
  | "account_needs_two_properties"
  | "property_not_in_account"
  | "property_not_ready"
  | "design_property_not_included"
  | "no_ready_property";

export type AccountBookingPageSaveCommand = {
  organizationId: string;
  update: AccountBookingPageUpdate;
  audit: {
    actorUserId: string;
    requestId: string;
    correlationId: string | null;
  };
};

export type AccountBookingPagesRepository = {
  /** Null when the account isn't an active hotel account. */
  read(organizationId: string): Promise<AccountBookingPageSummary | null>;
  save(
    command: AccountBookingPageSaveCommand,
  ): Promise<
    | { ok: true; summary: AccountBookingPageSummary }
    | { ok: false; error: AccountBookingPageSaveError }
  >;
  close?(): Promise<void>;
};

type Queryable = Pick<PoolClient, "query">;

type AccountRow = {
  name: string;
  slug: string | null;
  live: boolean | null;
  settings: unknown;
  revision: number | null;
};

type PropertyRow = {
  propertyId: string;
  name: string;
  propertyType: string | null;
  area: string | null;
  active: boolean;
  located: boolean;
  photoUrl: string | null;
  units: number;
  publicContent: unknown;
  publishedPropertyId: string | null;
  position: number | null;
};

/**
 * The agency booking page (VAY-2456) as Booking Admin reads and saves it. One page per account; the
 * account's properties are its active owner/operator catalog links. Whether a property's booking page is
 * set up is read live with the public site's rule for setup publications (`visibleActiveBookingPublication`,
 * only while the site serves them); a hotel served only from a legacy profile counts as not set up.
 * Pricing prerequisites are the guest read's to check (VAY-2458). Saving locks only the page row, checks the revision and
 * replaces the included list; it takes no lock on identity or pricing rows beyond the key-share checks of
 * its foreign keys (the audit row's account), held until its commit right after.
 */
export function createPgAccountBookingPagesRepository(config: {
  connectionString: string;
  max?: number;
}): AccountBookingPagesRepository {
  if (!config.connectionString.trim())
    throw new Error("Account booking pages repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async read(organizationId) {
      const client = await pool.connect();
      try {
        return await summary(client, organizationId);
      } finally {
        client.release();
      }
    },

    async save(command) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '3s'");
        const result = await saveLocked(client, command);
        if (!result.ok) {
          await client.query("ROLLBACK");
          return result;
        }
        await client.query("COMMIT");
        const saved = await summary(client, command.organizationId);
        return saved ? { ok: true, summary: saved } : { ok: false, error: "account_not_found" };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const failure = error as { code?: unknown; constraint?: unknown };
        if (failure.code === "23505") {
          if (
            failure.constraint === "uq_account_booking_pages_slug" ||
            failure.constraint === "uq_booking_address_slug"
          )
            return { ok: false, error: "slug_taken" };
          // Another save created the page first.
          if (failure.constraint === "account_booking_pages_pkey")
            return { ok: false, error: "page_changed" };
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

async function saveLocked(
  client: Queryable,
  { organizationId, update, audit }: AccountBookingPageSaveCommand,
): Promise<{ ok: true } | { ok: false; error: AccountBookingPageSaveError }> {
  const current = (
    await client.query<{ revision: number }>(
      `SELECT revision FROM booking.account_booking_pages
       WHERE organization_id = $1::uuid FOR UPDATE`,
      [organizationId],
    )
  ).rows[0];
  if ((current?.revision ?? 0) !== update.revision) return { ok: false, error: "page_changed" };

  const account = await accountRow(client, organizationId);
  if (!account) return { ok: false, error: "account_not_found" };
  const properties = await propertyRows(client, organizationId);
  // A new page, or going live, needs two active properties. A saved page can always be kept or
  // switched off, also after the account shrank.
  if (activeCount(properties) < 2 && (update.live || !current))
    return { ok: false, error: "account_needs_two_properties" };
  const byId = new Map(properties.map((row) => [row.propertyId, row]));
  if (update.propertyIds.some((id) => !byId.has(id)))
    return { ok: false, error: "property_not_in_account" };
  const designId = update.settings.header.designPropertyId;
  if (designId && !update.propertyIds.includes(designId))
    return { ok: false, error: "design_property_not_included" };
  const readiness = await readinessOf(client, properties);
  // A property can only join the page once it is ready. One included earlier stays included while it
  // isn't (guests never see it), so an unrelated save isn't refused.
  if (update.propertyIds.some((id) => !readiness.get(id)?.ready && byId.get(id)?.position === null))
    return { ok: false, error: "property_not_ready" };
  if (update.live && !update.propertyIds.some((id) => readiness.get(id)?.ready))
    return { ok: false, error: "no_ready_property" };

  const saved = await client.query<{ revision: number }>(
    current
      ? `UPDATE booking.account_booking_pages
         SET slug = $2, live = $3, settings = $4::jsonb, revision = revision + 1, updated_at = now()
         WHERE organization_id = $1::uuid
         RETURNING revision`
      : `INSERT INTO booking.account_booking_pages (organization_id, slug, live, settings)
         VALUES ($1::uuid, $2, $3, $4::jsonb)
         RETURNING revision`,
    [organizationId, update.slug, update.live, JSON.stringify(update.settings)],
  );
  await client.query(
    "DELETE FROM booking.account_booking_page_properties WHERE organization_id = $1::uuid",
    [organizationId],
  );
  await client.query(
    `INSERT INTO booking.account_booking_page_properties (organization_id, property_id, position)
     SELECT $1::uuid, included.id, included.position - 1
     FROM unnest($2::uuid[]) WITH ORDINALITY AS included(id, position)`,
    [organizationId, update.propertyIds],
  );
  const revision = saved.rows[0]!.revision;
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id, actor_type,
       actor_user_id, target_resource_product, target_resource_type, target_resource_id,
       correlation_id, causation_id, redacted_payload, privacy_scope
     )
     VALUES ($1, 'booking', 'booking.account_booking_page.updated', now(), 'organization', $2::uuid,
       'user', $3::uuid, 'booking', 'account_booking_page', $2::uuid::text, $4, $5, $6::jsonb,
       'internal')`,
    [
      `booking.account-booking-page:${organizationId}:${randomUUID()}`,
      organizationId,
      audit.actorUserId,
      audit.correlationId ?? audit.requestId,
      audit.requestId,
      // Not the settings: they hold the agency's contact email and WhatsApp number, and this log is
      // append-only.
      JSON.stringify({
        revision,
        slug: update.slug,
        live: update.live,
        propertyIds: update.propertyIds,
      }),
    ],
  );
  return { ok: true };
}

async function summary(
  client: Queryable,
  organizationId: string,
): Promise<AccountBookingPageSummary | null> {
  const account = await accountRow(client, organizationId);
  if (!account) return null;
  const rows = await propertyRows(client, organizationId);
  const readiness = await readinessOf(client, rows);
  const defaults = defaultAccountBookingPageSettings(account.name);
  const saved = account.revision !== null;
  const propertyIds = saved
    ? rows
        .filter((row) => row.position !== null)
        .sort((a, b) => a.position! - b.position!)
        .map((row) => row.propertyId)
    : rows.filter((row) => readiness.get(row.propertyId)?.ready).map((row) => row.propertyId);
  const settings = saved ? readAccountBookingPageSettings(account.settings, defaults) : defaults;
  const designId = settings.header.designPropertyId;
  const included = new Set(propertyIds);
  return {
    saved,
    page: {
      slug: account.slug ?? suggestAccountBookingPageSlug(account.name),
      live: account.live ?? false,
      revision: account.revision ?? 0,
      // A property that left the page (or the account) no longer counts as the design source.
      settings:
        designId && !included.has(designId)
          ? { ...settings, header: { ...settings.header, designPropertyId: null } }
          : settings,
      propertyIds,
    },
    defaults,
    properties: rows.map((row) => ({
      propertyId: row.propertyId,
      name: row.name,
      propertyType: row.propertyType,
      area: row.area,
      photoUrl: row.photoUrl,
      units: row.units,
      ready: readiness.get(row.propertyId)!.ready,
      missing: readiness.get(row.propertyId)!.missing,
      included: included.has(row.propertyId),
    })),
    canSave: activeCount(rows) >= 2,
  };
}

async function accountRow(client: Queryable, organizationId: string): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(
    `SELECT organization.name, page.slug, page.live, page.settings, page.revision
     FROM identity.organizations organization
     LEFT JOIN booking.account_booking_pages page ON page.organization_id = organization.id
     WHERE organization.id = $1::uuid
       AND organization.kind = 'hotel_group'
       AND organization.status = 'active'`,
    [organizationId],
  );
  return result.rows[0] ?? null;
}

/** The account's properties: its active owner/operator catalog links, by name. */
async function propertyRows(
  client: Queryable,
  organizationId: string,
  /** Only the stays the page includes (VAY-2458: the public read). */
  includedOnly = false,
): Promise<PropertyRow[]> {
  const result = await client.query<PropertyRow>(
    `SELECT property.id::text AS "propertyId", property.display_name AS name,
            property.property_type AS "propertyType", location.area,
            property.lifecycle_status = 'active' AS active,
            (location.latitude IS NOT NULL AND location.longitude IS NOT NULL) AS located,
            (SELECT photo FROM unnest(ARRAY[
               revision.public_content #>> '{profile,hotel,branding,heroImage}',
               revision.public_content #>> '{rooms,0,images,0,url}'
             ]) WITH ORDINALITY AS candidate(photo, rank)
             WHERE photo LIKE 'https://%' ORDER BY rank LIMIT 1) AS "photoUrl",
            (SELECT count(*)::int FROM pms.rooms room
             WHERE room.property_id = property.id AND room.status <> 'retired') AS units,
            revision.public_content AS "publicContent",
            active.property_id::text AS "publishedPropertyId",
            included.position
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN distribution.active_public_booking_revision active
       ON active.property_id = property.id
     LEFT JOIN distribution.public_booking_content_revisions revision
       ON revision.id = active.content_revision_id AND revision.property_id = active.property_id
     LEFT JOIN booking.account_booking_page_properties included
       ON included.organization_id = $1::uuid AND included.property_id = property.id
     WHERE EXISTS (
       SELECT 1 FROM identity.organization_resource_links link
       WHERE link.organization_id = $1::uuid
         AND link.product = 'hotel_catalog'
         AND link.resource_type = 'property'
         AND link.resource_id = property.id::text
         AND link.status = 'active'
         AND link.relationship IN ('owner', 'operator')
     )
       AND ($2::boolean IS FALSE OR included.property_id IS NOT NULL)
     ORDER BY property.display_name, property.id`,
    [organizationId, includedOnly],
  );
  return result.rows;
}

const activeCount = (rows: PropertyRow[]) => rows.filter((row) => row.active).length;

async function readinessOf(
  client: Queryable,
  rows: PropertyRow[],
): Promise<Map<string, { ready: boolean; missing: AccountBookingPageMissing[] }>> {
  const gate = activeBookingPublicationGateConfig();
  const readiness = new Map<string, { ready: boolean; missing: AccountBookingPageMissing[] }>();
  for (const row of rows) {
    const visible =
      gate.servesPublications && row.active && row.publishedPropertyId
        ? await visibleActiveBookingPublication(
            client,
            { propertyId: row.publishedPropertyId, publicContent: row.publicContent },
            gate,
          )
        : null;
    const missing: AccountBookingPageMissing[] = [];
    if (!visible) missing.push("setup");
    if (!row.propertyType?.trim()) missing.push("type");
    if (!row.located) missing.push("location");
    readiness.set(row.propertyId, { ready: missing.length === 0, missing });
  }
  return readiness;
}

/**
 * VAY-2458: the stays guests see on a live agency page, in the page's order, each with its booking
 * address: included, ready by the rule above, and still the account's own. That is, the account
 * is the single organization linked as owner or operator to both the PMS and the catalog property,
 * as public pricing requires (`owningOrganization`). Null when no live page has this address.
 */
export async function readLiveAccountBookingPageStays(
  client: Queryable,
  slug: string,
): Promise<{
  organizationId: string;
  stays: { propertyId: string; slug: string; childrenEnabled: boolean }[];
} | null> {
  if (!parseAccountBookingPageSlug(slug)) return null;
  const page = (
    await client.query<{ organizationId: string }>(
      `SELECT page.organization_id::text AS "organizationId"
       FROM booking.account_booking_pages page
       JOIN identity.organizations account
         ON account.id = page.organization_id AND account.kind = 'hotel_group'
        AND account.status = 'active'
       WHERE page.slug = $1 AND page.live`,
      [slug],
    )
  ).rows[0];
  if (!page) return null;
  const rows = await propertyRows(client, page.organizationId, true);
  const readiness = await readinessOf(client, rows);
  const ready = rows
    .filter((row) => readiness.get(row.propertyId)?.ready)
    .sort((a, b) => a.position! - b.position!);
  if (!ready.length) return { organizationId: page.organizationId, stays: [] };
  const ids = ready.map((row) => row.propertyId);
  const [addresses, owners] = await Promise.all([
    client.query<{ propertyId: string; slug: string }>(
      `SELECT property_id::text AS "propertyId", slug
       FROM hotel_catalog.property_slugs
       WHERE property_id = ANY($1::uuid[]) AND locale IS NULL
         AND purpose = 'canonical' AND status = 'active'`,
      [ids],
    ),
    client.query<{ propertyId: string; owners: string[] }>(
      `SELECT owner.resource_id AS "propertyId", array_agg(owner.organization_id::text) AS owners
       FROM (
         SELECT resource_id, organization_id
         FROM identity.organization_resource_links
         WHERE resource_id = ANY($1::text[]) AND status = 'active'
           AND relationship IN ('owner', 'operator')
           AND ((product = 'pms' AND resource_type = 'pms_property')
             OR (product = 'hotel_catalog' AND resource_type = 'property'))
         GROUP BY resource_id, organization_id
         HAVING count(DISTINCT product) = 2
       ) owner
       GROUP BY owner.resource_id`,
      [ids],
    ),
  ]);
  const address = new Map(addresses.rows.map((row) => [row.propertyId, row.slug]));
  const owned = new Set(
    owners.rows
      .filter((row) => row.owners.length === 1 && row.owners[0] === page.organizationId)
      .map((row) => row.propertyId),
  );
  return {
    organizationId: page.organizationId,
    stays: ready.flatMap((row) => {
      const slug = address.get(row.propertyId);
      return slug && owned.has(row.propertyId)
        ? [
            {
              propertyId: row.propertyId,
              slug,
              childrenEnabled: childrenEnabled(row.publicContent),
            },
          ]
        : [];
    }),
  };
}

/** Whether the stay's published page takes children; its page counts none when it doesn't. */
function childrenEnabled(publicContent: unknown): boolean {
  const content = publicContent as {
    profile?: { hotel?: { supportedQuoteParameters?: { childrenSupported?: unknown } } };
  } | null;
  return content?.profile?.hotel?.supportedQuoteParameters?.childrenSupported !== false;
}

/**
 * VAY-2458: which of these stays have this promo code, active, as the quote matches it
 * (`replacementPromoCode`: the code as typed, upper-cased). Other stays are priced without it.
 */
export async function readStaysWithPromoCode(
  client: Queryable,
  propertyIds: string[],
  code: string,
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ propertyId: string }>(
    `SELECT DISTINCT property_id::text AS "propertyId"
     FROM booking.promo_definitions
     WHERE property_id = ANY($1::uuid[]) AND code = $2 AND status = 'active'`,
    [propertyIds, code.toUpperCase()],
  );
  return new Set(result.rows.map((row) => row.propertyId));
}
