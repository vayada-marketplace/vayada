import type { ReplacementPricingPublicationReader } from "./replacementPricingPublicationReader.js";
import type { BookingGuestChoicePublicationReader } from "./bookingGuestChoicePublication.js";
import {
  createBookingLaunchReadinessProvider,
  type BookingPublicationAuditContext,
  type BookingPublicationCommandPort,
  type BookingPublicationOperation,
  type BookingDesignReadinessPort,
  type ManualPricingPaymentMethod,
  type ReadyBookingPublicationEvidence,
} from "@vayada/domain-booking";
import { createBookingPublicationBuilder } from "@vayada/domain-distribution/booking-publication-builder";
import type { HotelMediaResolutionPort } from "@vayada/domain-hotels";
import type {
  PmsInventoryLaunchReadinessReadPort,
  PmsOperatingCalendarReadPort,
  PmsPricingReadPort,
  RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";
import type { FinancePaymentReadinessReadPort } from "@vayada/domain-finance";

import { createBookingBookingPublicationSource } from "./bookingBookingPublicationSource.js";
import { createPgBookingPublicationAttemptStatusRepository } from "./bookingPublicationAttemptStatusRepository.js";
import { createPgBookingPublicationCommandRepository } from "./bookingPublicationCommandRepository.js";
import {
  createBookingPublicationProjector,
  type BookingPublicationProjector,
} from "./bookingPublicationProjector.js";
import { createPgDistributionBookingPublicationProjection } from "./distributionBookingPublicationProjection.js";
import { createTargetFinanceBillingConfigReadPort } from "./financeBillingConfigReadModel.js";
import { createFinanceBookingLaunchEvidenceAdapter } from "./financeBookingLaunchEvidence.js";
import type { FinancePaymentReadinessScopePort } from "./financePaymentReadinessReadModel.js";
import { createFinanceBookingPublicationSnapshotPort } from "./financeBookingPublicationSnapshot.js";
import type { FinanceManualPaymentReadinessReadPort } from "./financeManualPaymentReadiness.js";
import { createHotelCatalogBookingPublicationSource } from "./hotelCatalogBookingPublicationSource.js";
import { createPmsBookingPublicationSource } from "./pmsBookingPublicationSource.js";

type PmsPricingCurrencyReadPort = Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;

export type BookingPublicationProductionRuntime = {
  routes: {
    repository: ReturnType<typeof createPgBookingPublicationCommandRepository>;
    readinessProvider: ReturnType<typeof createBookingLaunchReadinessProvider>;
  };
  projector: BookingPublicationProjector;
  refresh: BookingPublicationRefreshPort["refresh"];
  close(): Promise<void>;
};

export type BookingPublicationRefreshPort = {
  refresh(input: {
    organizationId: string;
    propertyId: string;
    actorUserId: string;
    idempotencyKey: string;
    audit: BookingPublicationAuditContext;
    /** Only republish a page that is already live; null when the hotel has not gone live. */
    onlyIfLive?: boolean;
  }): Promise<BookingPublicationOperation | null>;
};

type BookingPublicationRefreshDependencies = {
  readinessProvider: Pick<
    ReturnType<typeof createBookingLaunchReadinessProvider>,
    "getBookingReadiness"
  >;
  projection: Pick<
    ReturnType<typeof createPgDistributionBookingPublicationProjection>,
    "getActive"
  >;
  repository: Pick<BookingPublicationCommandPort, "requestPublication" | "getPublicationStatus">;
  projector: Pick<BookingPublicationProjector, "projectPending">;
};

// A live page's refresh that meets another publication of the same hotel (a save a moment after
// another save, ~1 s each) waits for it and asks again, so the later save still reaches guests
// (VAY-2344). Each retry needs its own key: the conflict is recorded against the first one.
const LIVE_REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const LIVE_REFRESH_RETRIED_CONFLICTS = new Set([
  "publication_in_progress",
  "active_content_revision_conflict",
]);
// The request and another refresh's projection can deadlock on the hotel's rows; Postgres
// rolls one back whole, so asking again is safe (deadlock_detected, serialization_failure).
const LIVE_REFRESH_RETRIED_SQLSTATES = new Set(["40P01", "40001"]);

export function createBookingPublicationRefresh(
  dependencies: BookingPublicationRefreshDependencies,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): BookingPublicationRefreshPort["refresh"] {
  return async ({ onlyIfLive, ...input }) => {
    for (let attempt = 0; ; attempt += 1) {
      const delay = LIVE_REFRESH_RETRY_DELAYS_MS[attempt];
      const active = await dependencies.projection.getActive(input.propertyId);
      // A save never makes the page public; only "Publish booking page" does (VAY-2129).
      if (onlyIfLive && !active) return null;
      const readiness = await dependencies.readinessProvider.getBookingReadiness({
        organizationId: input.organizationId,
        propertyId: input.propertyId,
      });
      if (
        readiness.outcome !== "evaluated" ||
        readiness.product !== "booking" ||
        readiness.status !== "ready"
      ) {
        // A read that failed (retryable by contract) may meet the other publication's locks.
        if (onlyIfLive && delay !== undefined && readiness.outcome === "provider_failure") {
          await wait(delay);
          continue;
        }
        throw new Error(
          `Booking publication readiness is incomplete. (${readinessSummary(readiness)})`,
        );
      }
      let requested: Awaited<
        ReturnType<BookingPublicationRefreshDependencies["repository"]["requestPublication"]>
      >;
      try {
        requested = await dependencies.repository.requestPublication({
          ...input,
          idempotencyKey: attempt
            ? `${input.idempotencyKey}:retry-${attempt}`
            : input.idempotencyKey,
          expectedActiveContentRevisionId: active?.revisionId ?? null,
          readiness: readiness as ReadyBookingPublicationEvidence,
        });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (!onlyIfLive || delay === undefined || !LIVE_REFRESH_RETRIED_SQLSTATES.has(String(code)))
          throw error;
        await wait(delay);
        continue;
      }
      if (!requested.ok) {
        if (
          !onlyIfLive ||
          delay === undefined ||
          !LIVE_REFRESH_RETRIED_CONFLICTS.has(requested.error.code)
        )
          throw new Error(`Booking publication refresh failed: ${requested.error.code}.`);
        await wait(delay);
        continue;
      }
      await dependencies.projector.projectPending({ propertyId: input.propertyId });
      const operation = await dependencies.repository.getPublicationStatus({
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        operationId: requested.operation.operationId,
        actorUserId: input.actorUserId,
      });
      if (!operation || operation.status === "failed" || operation.status === "unknown") {
        throw new Error("Booking publication refresh did not complete.");
      }
      return operation;
    }
  };
}

/** Codes only, for the logs: the failed read, or the status and its blockers. */
function readinessSummary(
  readiness: Awaited<
    ReturnType<BookingPublicationRefreshDependencies["readinessProvider"]["getBookingReadiness"]>
  >,
): string {
  if (readiness.outcome !== "evaluated")
    return `${readiness.outcome}: ${readiness.error.errorSource}/${readiness.error.code}`;
  const blockers = readiness.groups.flatMap((group) =>
    group.steps.flatMap((step) =>
      step.entities.flatMap((entity) =>
        entity.blockers.map((blocker) => `${group.groupId}:${blocker.code}`),
      ),
    ),
  );
  return `${readiness.product} ${readiness.status}: ${blockers.join(", ") || "no blockers"}`;
}

export type BookingPublicationWorker = { close(): Promise<void> };

export function startBookingPublicationWorker(config: {
  projector: BookingPublicationProjector;
  workerId: string;
  warn(error: unknown, message: string): void;
  intervalMs?: number;
}): BookingPublicationWorker {
  let active: Promise<void> | undefined;
  let closed = false;
  const run = () => {
    if (closed || active) return;
    active = config.projector
      .runRetryBatch({ workerId: config.workerId })
      .then(({ failed, exhausted }) => {
        if (failed > 0) {
          config.warn({ failed, exhausted }, "Booking publication worker completed with failures");
        }
      })
      .catch((error: unknown) => config.warn({ err: error }, "Booking publication worker failed"))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(run, config.intervalMs ?? 30_000);
  timer.unref();
  run();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}

export function createBookingPublicationProductionRuntime(config: {
  connectionString: string;
  bookingHostBase?: string;
  mediaResolver: HotelMediaResolutionPort;
  design: BookingDesignReadinessPort;
  guestRules: BookingGuestChoicePublicationReader;
  rooms: RoomPublicationSnapshotPort;
  pricing: ReplacementPricingPublicationReader;
  pricingCurrency: PmsPricingCurrencyReadPort;
  operatingCalendar: PmsOperatingCalendarReadPort;
  inventory: PmsInventoryLaunchReadinessReadPort;
  finance: FinancePaymentReadinessReadPort;
  /** Bank transfer and PayPal, only while their acceptance is on (VAY-2139). */
  manualPayments?: FinanceManualPaymentReadinessReadPort;
  /** Which of the two the booking page takes now (replacementPricingManualPaymentMethods). */
  manualMethods?: readonly ManualPricingPaymentMethod[];
  financeScope?: FinancePaymentReadinessScopePort;
  /** Receives one line per readiness check an owner could not answer (IDs and codes only). */
  warn?: (fields: Record<string, unknown>, message: string) => void;
}): BookingPublicationProductionRuntime {
  const catalog = createHotelCatalogBookingPublicationSource({
    connectionString: config.connectionString,
    mediaResolver: config.mediaResolver,
  });
  const booking = createBookingBookingPublicationSource({
    connectionString: config.connectionString,
    design: config.design,
    guestRules: config.guestRules,
  });
  const pms = createPmsBookingPublicationSource({
    rooms: config.rooms,
    pricing: config.pricing,
    pricingCurrency: config.pricingCurrency,
    operatingCalendar: config.operatingCalendar,
    inventory: config.inventory,
  });
  const billingPlan = createTargetFinanceBillingConfigReadPort({
    connectionString: config.connectionString,
    max: 1,
  });
  const financeEvidence = createFinanceBookingLaunchEvidenceAdapter({
    financeReadPort: config.finance,
    billingPlan,
    manualPayments: config.manualPayments,
    ...(config.financeScope ? { scope: config.financeScope } : {}),
  });
  const financeSnapshot = createFinanceBookingPublicationSnapshotPort({
    financeReadPort: config.finance,
    manualPayments: config.manualPayments,
  });
  const readinessProvider = createBookingLaunchReadinessProvider({
    catalog,
    booking,
    pms,
    finance: financeEvidence,
    onUnavailable: (event) =>
      config.warn?.({ ...event }, "Booking launch readiness owner unavailable"),
  });
  const builder = createBookingPublicationBuilder({
    catalog,
    booking,
    pms,
    finance: financeSnapshot,
    bookingWeb: ({ slug, customDomainUrl, domainVerified }) => {
      const custom = domainVerified ? safeOrigin(customDomainUrl) : null;
      const bookingBaseUrl = custom ?? fallbackBookingBaseUrl(slug, config.bookingHostBase);
      return {
        canonicalUrl: bookingBaseUrl,
        bookingBaseUrl,
        customDomainUrl: custom,
        domainVerified: Boolean(custom),
        bookingDeepLinks: true,
      };
    },
  });
  // The manual-payment reader exists only while bank-transfer and PayPal acceptance is on.
  const manualPayments = config.manualPayments !== undefined;
  const projection = createPgDistributionBookingPublicationProjection({
    connectionString: config.connectionString,
    manualPayments,
    manualMethods: config.manualMethods,
  });
  const attempts = createPgBookingPublicationAttemptStatusRepository({
    connectionString: config.connectionString,
  });
  const repository = createPgBookingPublicationCommandRepository({
    connectionString: config.connectionString,
    activeContent: projection,
  });
  const projector = createBookingPublicationProjector({
    connectionString: config.connectionString,
    projection,
    attempts,
    readiness: readinessProvider,
    builder,
    warn: config.warn,
  });
  const refresh = createBookingPublicationRefresh({
    readinessProvider,
    projection,
    repository,
    projector,
  });
  return {
    routes: { repository, readinessProvider },
    projector,
    refresh,
    async close() {
      await Promise.all([
        projector.close?.(),
        projection.close?.(),
        attempts.close?.(),
        catalog.close(),
        booking.close(),
        billingPlan.close?.(),
      ]);
    },
  };
}

function fallbackBookingBaseUrl(slug: string, input = "booking.vayada.com"): string {
  const host = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  return `https://${slug}.${host || "booking.vayada.com"}`;
}

function safeOrigin(input: string | null): string | null {
  try {
    if (!input) return null;
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}
