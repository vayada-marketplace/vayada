import {
  createFinancePaymentMethodsSourceEntityRevision,
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import {
  BOOKING_OWNER_SNAPSHOT_VERSION,
  type BookingPublicationOwnerSnapshotPort,
} from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import type { BookingPublicPaymentMethod } from "@vayada/domain-distribution/booking-publication";
import type { FinanceManualPaymentReadinessReadPort } from "./financeManualPaymentReadiness.js";

export function createFinanceBookingPublicationSnapshotPort(dependencies: {
  financeReadPort: FinancePaymentReadinessReadPort;
  /** Bank transfer and PayPal, only while their acceptance is on (VAY-2139). */
  manualPayments?: FinanceManualPaymentReadinessReadPort;
}): BookingPublicationOwnerSnapshotPort<"finance"> {
  return {
    owner: "finance",
    async getSnapshot(request) {
      try {
        const value = await dependencies.financeReadPort.getPaymentReadiness({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
        });
        const snapshot = value === null ? null : parseFinancePaymentReadinessSnapshot(value);
        if (
          !snapshot ||
          snapshot.propertyId !== request.propertyId ||
          !snapshot.updatedAt ||
          !snapshot.pricingCurrency.committed ||
          !snapshot.pricingCurrency.matchesCurrent
        ) {
          return unavailable();
        }
        const source = createFinancePaymentMethodsSourceEntityRevision(
          snapshot.propertyId,
          snapshot.paymentMethodsRevision,
        );
        const expectedSources = request.sourceManifest.sources.filter(
          ({ ownerDomain }) => ownerDomain === "finance",
        );
        if (expectedSources.length !== 1 || sourceKey(expectedSources[0]!) !== sourceKey(source)) {
          return unavailable();
        }
        const ready = snapshot.methods
          .filter(
            ({ method, selected, availability, readiness }) =>
              (method === "card" || method === "pay_at_property") &&
              selected &&
              availability === "available" &&
              readiness === "ready",
          )
          .map(({ method }) => method as BookingPublicPaymentMethod);
        // Bank transfer and PayPal only for a hotel without a ready card or pay-at-property method.
        const readyPaymentMethods: BookingPublicPaymentMethod[] =
          snapshot.bookingPaymentReady && ready.length > 0
            ? ready
            : dependencies.manualPayments
              ? [
                  ...(await dependencies.manualPayments.readyMethods({
                    organizationId: request.organizationId,
                    propertyId: request.propertyId,
                  })),
                ]
              : [];
        if (readyPaymentMethods.length === 0) return unavailable();
        const currency = snapshot.pricingCurrency.committed.currency;
        return deepFreeze({
          outcome: "snapshot",
          contractVersion: BOOKING_OWNER_SNAPSHOT_VERSION,
          owner: "finance",
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          sourceManifestHash: request.sourceManifestHash,
          resolvedSources: [source],
          content: {
            defaultCurrency: currency,
            supportedCurrencies: [currency],
            onlinePayment: readyPaymentMethods.includes("card"),
            payAtProperty: readyPaymentMethods.includes("pay_at_property"),
            readyPaymentMethods,
            freshness: { status: "fresh", lastUpdatedAt: snapshot.updatedAt },
          },
        });
      } catch {
        return unavailable();
      }
    },
  };
}

const sourceKey = (source: {
  ownerDomain: string;
  entityType: string;
  entityId: string;
  revision: string;
}) => JSON.stringify([source.ownerDomain, source.entityType, source.entityId, source.revision]);

const unavailable = () => ({ outcome: "unavailable" as const, owner: "finance" as const });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
