import type { QueryResult, QueryResultRow } from "pg";

import { canPublishBookingPage } from "./bookingPublicationCommandRepository.js";
import type { BookingPublicationRefreshPort } from "./bookingPublicationProductionRuntime.js";

export const BOOKING_GUEST_POLICY_REFRESH_SOURCE = "booking.guest_policy_projection";

type RefreshPool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

export type BookingGuestPolicyLivePageRefresh = (input: {
  organizationId: string;
  propertyId: string;
  outboxEventId: string;
}) => Promise<void>;

/** After the guest-policy projection applies a change, a live booking page is rebuilt so guests
 * see the new arrival times and policies (VAY-2129). The projection runs in a background job with
 * no signed-in user, so the page is republished as the user who made it live, re-checked for
 * access first, like an operator's address change (VAY-2295). A page that is not live is left
 * alone: only "Publish booking page" makes it public. Every failure is logged, never thrown; the
 * next save or policy change refreshes the page again (VAY-2350). */
export function createBookingGuestPolicyLivePageRefresh(config: {
  pool: RefreshPool;
  refresh: BookingPublicationRefreshPort["refresh"];
  warn: (details: Record<string, unknown>, message: string) => void;
  now?: () => Date;
}): BookingGuestPolicyLivePageRefresh {
  const now = config.now ?? (() => new Date());
  return async ({ organizationId, propertyId, outboxEventId }) => {
    const details = { organizationId, propertyId, outboxEventId };
    try {
      const live = (
        await config.pool.query<{ userId: string }>(
          `SELECT activated_by_user_id::text AS "userId"
           FROM distribution.active_public_booking_revision
           WHERE property_id = $1::uuid`,
          [propertyId],
        )
      ).rows[0];
      if (!live) return;
      const actorUserId = live.userId;
      if (
        !(await canPublishBookingPage(
          config.pool,
          { organizationId, propertyId, actorUserId },
          now(),
        ))
      ) {
        config.warn(
          { ...details, actorUserId },
          "Booking page not refreshed after a guest policy change: the user who made it live can no longer publish it",
        );
        return;
      }
      await config.refresh({
        organizationId,
        propertyId,
        actorUserId,
        idempotencyKey: `${BOOKING_GUEST_POLICY_REFRESH_SOURCE}:${outboxEventId}`,
        audit: { requestId: outboxEventId, source: BOOKING_GUEST_POLICY_REFRESH_SOURCE },
        onlyIfLive: true,
      });
    } catch (error) {
      config.warn(
        { ...details, err: error },
        "Booking page refresh after a guest policy change failed",
      );
    }
  };
}
