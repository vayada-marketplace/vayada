import { createHash, randomUUID } from "node:crypto";

import type {
  BookingPublicationOperationStatus,
  createBookingLaunchReadinessProvider,
} from "@vayada/domain-booking";
import { PUBLIC_BOOKABILITY_SLUG_PATTERN } from "@vayada/domain-distribution";
import pg, { type PoolClient } from "pg";

import { projectPropertyPublicProfile } from "../platform/propertyPublicProfileProjection.js";
import { hotelAddressSql } from "./activeBookingPublicationGate.js";
import { canPublishBookingPage } from "./bookingPublicationCommandRepository.js";
import { lockBookingPublication } from "./bookingPublicationLock.js";
import type { BookingPublicationRefreshPort } from "./bookingPublicationProductionRuntime.js";
import {
  PlatformPropertyLifecycleError,
  requireAuthorizedPlatformActor,
  type PlatformPropertyLifecycleAudit,
} from "./platformPropertyLifecycleCommandRepository.js";

export const PROPERTY_SLUG_CHANGE_CONTRACT_VERSION = "platform-admin-property-slug-change.v1";

/** What an operator's address change will do. The go names the SHA-256 of exactly this. */
export type PropertySlugChangePlan = {
  contractVersion: typeof PROPERTY_SLUG_CHANGE_CONTRACT_VERSION;
  propertyId: string;
  fromSlug: string;
  toSlug: string;
  /** A free address, one of the hotel's former ones (a rollback), or the current one (a rerun). */
  change: "new_address" | "former_address" | "already_applied";
  /** The live page, republished as the user who made it live; null when none is live. */
  livePage: { pageSlug: string; organizationId: string; republishAsUserId: string } | null;
};

export type PropertySlugChangePreview = { plan: PropertySlugChangePlan; planSha256: string };

export type PropertySlugChangeResult = PropertySlugChangePreview & {
  publication:
    | { status: "not_live" | "current" }
    | { status: BookingPublicationOperationStatus; operationId: string }
    | { status: "failed"; code: string };
};

export type PropertySlugChangeErrorCode =
  | "invalid_platform_scope"
  | "invalid_slug"
  | "property_not_found"
  | "property_unavailable"
  | "canonical_slug_missing"
  | "slug_taken"
  | "legacy_page_only"
  | "publication_in_progress"
  | "republish_user_unavailable"
  | "page_not_ready"
  | "republish_unavailable"
  | "plan_changed";

export class PropertySlugChangeError extends Error {
  constructor(readonly code: PropertySlugChangeErrorCode) {
    super(code);
  }
}

export type PropertySlugChangeCommand = {
  preview(input: PreviewInput): Promise<PropertySlugChangePreview>;
  apply(
    input: PreviewInput & { reason: string; expectedPlanSha256: string },
  ): Promise<PropertySlugChangeResult>;
  close(): Promise<void>;
};

type PreviewInput = { propertyId: string; slug: string; audit: PlatformPropertyLifecycleAudit };
type Readiness = Pick<
  ReturnType<typeof createBookingLaunchReadinessProvider>,
  "getBookingReadiness"
>;
type SlugRow = {
  id: string;
  propertyId: string;
  slug: string;
  locale: string | null;
  purpose: string;
  status: string;
};
type Planned = PropertySlugChangePreview & { currentId: string; formerId: string | null };
// Booking hosts read these labels as non-hotel hosts (slugFromKnownBookingHost, booking-web).
const RESERVED_HOST_LABELS = new Set(["www", "booking"]);

/**
 * Changes a hotel's booking page address (VAY-2295): the new address becomes the active canonical
 * slug, every former one redirects to it, and a live page is republished. Swapping first and
 * republishing after leaves no gap for guests: the page keeps selling under its former address
 * until the republish moves it (publicationServesAddress).
 */
export function createPropertySlugChangeCommand(config: {
  connectionString?: string;
  pool?: pg.Pool;
  refresh?: BookingPublicationRefreshPort["refresh"];
  readiness?: Readiness;
}): PropertySlugChangeCommand {
  const ownsPool = !config.pool;
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 2 });

  const preview = async (input: PreviewInput) => {
    const planned = await transaction(pool, "BEGIN READ ONLY", (client) =>
      plan(client, input, false, new Date()),
    );
    const live = planned.plan.livePage;
    if (live && live.pageSlug !== input.slug) {
      // Without the publication runtime the page can't move, and the old address would stop
      // selling once it is no longer canonical.
      if (!config.refresh || !config.readiness)
        throw new PropertySlugChangeError("republish_unavailable");
      // Readiness owners read through their own pools, so this runs outside the transaction.
      const readiness = await config.readiness.getBookingReadiness({
        organizationId: live.organizationId,
        propertyId: input.propertyId,
      });
      if (
        readiness.outcome !== "evaluated" ||
        readiness.product !== "booking" ||
        readiness.status !== "ready"
      )
        throw new PropertySlugChangeError("page_not_ready");
    }
    return { plan: planned.plan, planSha256: planned.planSha256 };
  };

  return {
    preview,
    async apply(input) {
      if ((await preview(input)).planSha256 !== input.expectedPlanSha256)
        throw new PropertySlugChangeError("plan_changed");
      const at = new Date();
      const planned = await transaction(pool, "BEGIN", async (client) => {
        const locked = await plan(client, input, true, at);
        if (locked.planSha256 !== input.expectedPlanSha256)
          throw new PropertySlugChangeError("plan_changed");
        if (locked.plan.change !== "already_applied") {
          await swap(client, locked);
          await projectPropertyPublicProfile(client, { propertyId: input.propertyId });
          await recordAudit(client, locked, input, at);
        }
        return locked;
      }).catch((error: unknown) => {
        // Another hotel took the free address after the plan locked its rows.
        const failure = error as { code?: unknown; constraint?: unknown };
        if (failure.code === "23505" && failure.constraint === "uq_property_slugs_slug_locale")
          throw new PropertySlugChangeError("slug_taken");
        throw error;
      });
      const result = { plan: planned.plan, planSha256: planned.planSha256 };
      return { ...result, publication: await republish(config.refresh, result.plan, input.audit) };
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function plan(
  client: PoolClient,
  input: PreviewInput,
  locked: boolean,
  at: Date,
): Promise<Planned> {
  const { propertyId, slug: toSlug } = input;
  if (
    toSlug.length > 63 ||
    !PUBLIC_BOOKABILITY_SLUG_PATTERN.test(toSlug) ||
    RESERVED_HOST_LABELS.has(toSlug)
  )
    throw new PropertySlugChangeError("invalid_slug");
  try {
    await requireAuthorizedPlatformActor(client, input.audit, { lockRows: locked });
  } catch (error) {
    if (error instanceof PlatformPropertyLifecycleError)
      throw new PropertySlugChangeError("invalid_platform_scope");
    throw error;
  }
  if (locked) await lockBookingPublication(client, propertyId);
  const lock = (of: string) => (locked ? `FOR UPDATE OF ${of}` : "");
  const property = (
    await client.query<{ status: string }>(
      `SELECT lifecycle_status AS status FROM hotel_catalog.properties p
       WHERE p.id = $1::uuid ${lock("p")}`,
      [propertyId],
    )
  ).rows[0];
  if (!property) throw new PropertySlugChangeError("property_not_found");
  if (property.status === "suspended" || property.status === "retired")
    throw new PropertySlugChangeError("property_unavailable");

  const rows = (
    await client.query<SlugRow>(
      `SELECT s.id::text AS id, s.property_id::text AS "propertyId", s.slug, s.locale, s.purpose,
              s.status
       FROM hotel_catalog.property_slugs s
       WHERE (s.property_id = $1::uuid AND s.locale IS NULL AND ${hotelAddressSql("s")})
          OR s.slug = $2
       ORDER BY s.id ${lock("s")}`,
      [propertyId, toSlug],
    )
  ).rows;
  const current = rows.find(
    (row) =>
      row.propertyId === propertyId && row.purpose === "canonical" && row.status === "active",
  );
  if (!current) throw new PropertySlugChangeError("canonical_slug_missing");
  // Slugs are unique for good: the address must be free, or one of this hotel's former ones.
  const taken = rows.filter((row) => row.slug === toSlug);
  const former =
    taken.length === 1 &&
    taken[0]!.propertyId === propertyId &&
    taken[0]!.locale === null &&
    taken[0]!.purpose === "redirect" &&
    taken[0]!.status === "redirected"
      ? taken[0]!
      : null;
  const change =
    current.slug === toSlug
      ? "already_applied"
      : taken.length === 0
        ? "new_address"
        : former
          ? "former_address"
          : null;
  if (!change) throw new PropertySlugChangeError("slug_taken");

  const openAttempt = await client.query(
    `SELECT 1 FROM booking.booking_publication_attempts
     WHERE property_id = $1::uuid AND status IN ('pending', 'unknown')`,
    [propertyId],
  );
  if (openAttempt.rows.length) throw new PropertySlugChangeError("publication_in_progress");
  const live = (
    await client.query<{ pageSlug: string; userId: string }>(
      `SELECT revision.public_content #>> '{profile,hotel,slug}' AS "pageSlug",
              active.activated_by_user_id::text AS "userId"
       FROM distribution.active_public_booking_revision active
       JOIN distribution.public_booking_content_revisions revision
         ON revision.id = active.content_revision_id AND revision.property_id = active.property_id
       WHERE active.property_id = $1::uuid`,
      [propertyId],
    )
  ).rows[0];
  let livePage: PropertySlugChangePlan["livePage"] = null;
  if (live) {
    const owners = (
      await client.query<{ id: string }>(
        `SELECT DISTINCT organization_id::text AS id FROM identity.organization_resource_links
         WHERE product = 'booking' AND resource_type = 'booking_hotel' AND resource_id = $1
           AND relationship IN ('owner', 'operator') AND status = 'active'`,
        [propertyId],
      )
    ).rows;
    const organizationId = owners.length === 1 ? owners[0]!.id : null;
    if (
      !organizationId ||
      !(await canPublishBookingPage(
        client,
        { organizationId, propertyId, actorUserId: live.userId },
        at,
      ))
    )
      throw new PropertySlugChangeError("republish_user_unavailable");
    livePage = { pageSlug: live.pageSlug, organizationId, republishAsUserId: live.userId };
  } else {
    // A hotel that never published is served from its frozen legacy page, which can't move.
    const legacy = await client.query(
      `SELECT 1 FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = $1::uuid AND profile_status = 'public'`,
      [propertyId],
    );
    if (legacy.rows.length) throw new PropertySlugChangeError("legacy_page_only");
  }
  const result: PropertySlugChangePlan = {
    contractVersion: PROPERTY_SLUG_CHANGE_CONTRACT_VERSION,
    propertyId,
    fromSlug: current.slug,
    toSlug,
    change,
    livePage,
  };
  return {
    plan: result,
    planSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    currentId: current.id,
    formerId: former?.id ?? null,
  };
}

/** One active canonical row per hotel: free its slot, fill it, then point every former address
 * (including the one just replaced) at the new canonical row. */
async function swap(client: PoolClient, planned: Planned): Promise<void> {
  const { propertyId, toSlug } = planned.plan;
  await client.query(
    `UPDATE hotel_catalog.property_slugs SET purpose = 'redirect', status = 'retired', updated_at = now()
     WHERE id = $1::uuid`,
    [planned.currentId],
  );
  const canonical = planned.formerId
    ? await client.query<{ id: string }>(
        `UPDATE hotel_catalog.property_slugs
         SET purpose = 'canonical', status = 'active', redirects_to_id = NULL, updated_at = now()
         WHERE id = $1::uuid RETURNING id::text AS id`,
        [planned.formerId],
      )
    : await client.query<{ id: string }>(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
         VALUES ($1::uuid, $2, 'canonical', 'active') RETURNING id::text AS id`,
        [propertyId, toSlug],
      );
  await client.query(
    `UPDATE hotel_catalog.property_slugs
     SET status = 'redirected', redirects_to_id = $2::uuid, updated_at = now()
     WHERE property_id = $1::uuid AND locale IS NULL AND purpose = 'redirect'
       AND (status = 'redirected' OR id = $3::uuid)`,
    [propertyId, canonical.rows[0]!.id, planned.currentId],
  );
}

async function recordAudit(
  client: PoolClient,
  planned: Planned,
  input: { reason: string; audit: PlatformPropertyLifecycleAudit },
  at: Date,
): Promise<void> {
  const { plan: change, planSha256 } = planned;
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, correlation_id, causation_id,
       redacted_payload, private_payload, audit_metadata, privacy_scope
     ) VALUES ($1, 'hotel_catalog', 'platform.property.slug.change', $2::timestamptz, 'property',
       $3::uuid, 'user', $4::uuid, 'hotel_catalog', 'property', $3, $5, $6,
       $7::jsonb, $8::jsonb, $9::jsonb, 'confidential')`,
    [
      `platform-property-slug-change:${randomUUID()}`,
      at.toISOString(),
      change.propertyId,
      input.audit.actorUserId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({
        fromSlug: change.fromSlug,
        toSlug: change.toSlug,
        planSha256,
        republishAsUserId: change.livePage?.republishAsUserId ?? null,
      }),
      JSON.stringify({ reason: input.reason }),
      JSON.stringify({
        contractVersion: PROPERTY_SLUG_CHANGE_CONTRACT_VERSION,
        actorOrganizationId: input.audit.organizationId,
        requestedAt: input.audit.requestedAt,
      }),
    ],
  );
}

/** The address change is committed; a failed republish leaves the page selling under its former
 * address, and running the change again retries only the republish. */
async function republish(
  refresh: BookingPublicationRefreshPort["refresh"] | undefined,
  change: PropertySlugChangePlan,
  audit: PlatformPropertyLifecycleAudit,
): Promise<PropertySlugChangeResult["publication"]> {
  const live = change.livePage;
  if (!live) return { status: "not_live" };
  if (live.pageSlug === change.toSlug) return { status: "current" };
  if (!refresh) return { status: "failed", code: "republish_unavailable" };
  try {
    const operation = await refresh({
      organizationId: live.organizationId,
      propertyId: change.propertyId,
      actorUserId: live.republishAsUserId,
      idempotencyKey: `platform-property-slug-change:${audit.requestId}`,
      audit: {
        requestId: audit.requestId,
        correlationId: audit.correlationId,
        source: "platform_admin.property_slug_change",
      },
      onlyIfLive: true,
    });
    return operation
      ? { status: operation.status, operationId: operation.operationId }
      : { status: "not_live" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code =
      /readiness is incomplete/.exec(message) !== null
        ? "page_not_ready"
        : (/refresh failed: ([a-z_]+)/.exec(message)?.[1] ?? "publication_failed");
    return { status: "failed", code };
  }
}

async function transaction<T>(
  pool: pg.Pool,
  begin: "BEGIN" | "BEGIN READ ONLY",
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query(begin === "BEGIN" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
