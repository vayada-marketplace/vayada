import type { QueryResult, QueryResultRow } from "pg";

import { canPublishBookingPage } from "./bookingPublicationCommandRepository.js";
import {
  BookingPublicationNotReadyError,
  type BookingPublicationRefreshPort,
} from "./bookingPublicationProductionRuntime.js";

export const BOOKING_LIVE_PAGE_CATCH_UP_SOURCE = "booking.live_page_catch_up";

type CatchUpPool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

export type BookingLivePageCatchUpResult = {
  livePages: number;
  /** Pages that already show what their hotel saved. */
  unchanged: number;
  refreshed: string[];
  blocked: { propertyId: string; codes: string[] }[];
  noAccess: string[];
  failed: { propertyId: string; detail: string }[];
};

/** Republishes each live booking page whose hotel saved changes it doesn't show yet. A save's own
 * refresh fails while something blocks the page, e.g. a calendar that room changes made stale;
 * nothing republished it once that was fixed, so Tiga Lombok's new photos never reached guests
 * (VAY-2472). Pages that still match their sources are left alone. Like the guest-policy refresh
 * (VAY-2350), it runs as the user who made the page live, re-checked first, never as someone
 * else; the organization is the one that published the live page. Failures are reported, never
 * thrown: the next run tries again. Every live page is checked each run; one that already shows
 * its sources costs a readiness read. */
export async function catchUpLiveBookingPages(
  config: {
    pool: CatchUpPool;
    refresh: BookingPublicationRefreshPort["refresh"];
    now?: () => Date;
  },
  input: {
    runId: string;
    /** Only these hotels (a run limited to some of them); all live pages when left out. */
    propertyIds?: readonly string[];
  },
): Promise<BookingLivePageCatchUpResult> {
  const pages = (
    await config.pool.query<{
      propertyId: string;
      organizationId: string | null;
      actorUserId: string;
      sourceManifestHash: string;
    }>(
      `SELECT active.property_id::text AS "propertyId",
              attempt.organization_id::text AS "organizationId",
              active.activated_by_user_id::text AS "actorUserId",
              revision.source_manifest_hash AS "sourceManifestHash"
       FROM distribution.active_public_booking_revision active
       JOIN distribution.public_booking_content_revisions revision
         ON revision.id = active.content_revision_id
       JOIN hotel_catalog.properties property
         ON property.id = active.property_id AND property.lifecycle_status = 'active'
       LEFT JOIN LATERAL (
         SELECT organization_id FROM booking.booking_publication_attempts
         WHERE property_id = active.property_id
           AND result_content_revision_id = active.content_revision_id
         ORDER BY requested_at DESC LIMIT 1
       ) attempt ON TRUE
       WHERE $1::uuid[] IS NULL OR active.property_id = ANY($1::uuid[])
       ORDER BY active.activated_at`,
      [input.propertyIds ?? null],
    )
  ).rows;
  const result: BookingLivePageCatchUpResult = {
    livePages: pages.length,
    unchanged: 0,
    refreshed: [],
    blocked: [],
    noAccess: [],
    failed: [],
  };
  for (const { propertyId, organizationId, actorUserId, sourceManifestHash } of pages) {
    try {
      if (
        !organizationId ||
        !(await canPublishBookingPage(
          config.pool,
          { organizationId, propertyId, actorUserId },
          config.now?.() ?? new Date(),
        ))
      ) {
        result.noAccess.push(propertyId);
        continue;
      }
      const operation = await config.refresh({
        organizationId,
        propertyId,
        actorUserId,
        idempotencyKey: `${BOOKING_LIVE_PAGE_CATCH_UP_SOURCE}:${input.runId}:${propertyId}`,
        audit: { requestId: input.runId, source: BOOKING_LIVE_PAGE_CATCH_UP_SOURCE },
        onlyIfLive: true,
        skipIfSourceManifestHash: sourceManifestHash,
      });
      if (operation) result.refreshed.push(propertyId);
      else result.unchanged += 1;
    } catch (error) {
      if (error instanceof BookingPublicationNotReadyError) {
        result.blocked.push({
          propertyId,
          codes: [...new Set(error.blockers.map(({ groupId, code }) => `${groupId}:${code}`))],
        });
      } else {
        result.failed.push({
          propertyId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}
