/** Accepted hotel/PMS assertion; not physical proof or a payment authorization. */
export type PmsAffiliateCompletionEvidence =
  | { status: "pending"; reason: "scope_unavailable" | "completion_unconfirmed" }
  | {
      status: "completed";
      propertyId: string;
      bookingId: string;
      stayItemId: string;
      source: string;
      assertion: "authenticated_hotel_checkout";
      sourceRecordId: string;
      auditEventId: string;
      actorUserId: string;
      causedByCommandId: string;
      recordedAt: string;
      actualDepartureAt: string | null;
      hasPendingFlags: boolean;
    };
