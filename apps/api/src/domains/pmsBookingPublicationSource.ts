import {
  type BookingLaunchOwnerBlocker,
  type BookingLaunchPmsEvidencePort,
} from "@vayada/domain-booking";
import {
  BOOKING_OWNER_SNAPSHOT_VERSION,
  type BookingPublicationOwnerSnapshotPort,
  type BookingPublicationSnapshotContent,
} from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import type { SourceEntityRevision } from "@vayada/domain-hotels";
import {
  PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE,
  PMS_PRICING_SOURCE_ENTITY_TYPES,
  parsePropertyPricingCurrencySnapshot,
  serializePmsPricingSourceEntityRevision,
  type PmsInventoryLaunchReadinessReadPort,
  type PmsOperatingCalendarReadPort,
  type PmsPricingReadPort,
  type RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";

import type {
  PricingGap,
  ReplacementPricingPublicationReader,
} from "./replacementPricingPublicationReader.js";
import { buildPmsBookingPublicationContent } from "./pmsBookingPublicationContent.js";

type PmsSource = Omit<SourceEntityRevision, "ownerDomain"> & { ownerDomain: "pms" };
type LoadedPms = {
  sources: PmsSource[];
  rooms: readonly { source: PmsSource; blockers: BookingLaunchOwnerBlocker[] }[];
  pricingSource: PmsSource;
  pricingBlockers: BookingLaunchOwnerBlocker[];
  calendarSource: PmsSource;
  calendarBlockers: BookingLaunchOwnerBlocker[];
  content: BookingPublicationSnapshotContent["pms"] | null;
};

export function createPmsBookingPublicationSource(dependencies: {
  rooms: RoomPublicationSnapshotPort;
  pricing: ReplacementPricingPublicationReader;
  /** Finance binds payment methods to this currency source. */
  pricingCurrency: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  operatingCalendar: PmsOperatingCalendarReadPort;
  inventory: PmsInventoryLaunchReadinessReadPort;
  now?: () => Date;
}): BookingLaunchPmsEvidencePort & BookingPublicationOwnerSnapshotPort<"pms"> {
  const now = dependencies.now ?? (() => new Date());
  return {
    bookingLaunchEvidencePort: "pms",
    owner: "pms",
    async getBookingLaunchEvidence(request) {
      try {
        const loaded = await load(dependencies, request, now());
        if (typeof loaded === "string") return unavailableEvidence("provider", loaded);
        return deepFreeze({
          outcome: "evidence",
          port: "pms",
          ...request,
          sources: loaded.sources,
          entities: [
            ...(loaded.rooms.length
              ? loaded.rooms.map(({ source, blockers }) => ({
                  groupId: "booking.rooms" as const,
                  owningStepId: "rooms" as const,
                  source,
                  blockers,
                }))
              : [
                  {
                    groupId: "booking.rooms" as const,
                    owningStepId: "rooms" as const,
                    source: loaded.pricingSource,
                    blockers: [blocker("publishable_room_required")],
                  },
                ]),
            {
              groupId: "booking.pricing",
              owningStepId: "pricing",
              source: loaded.pricingSource,
              blockers: loaded.pricingBlockers,
            },
            {
              groupId: "booking.calendar",
              owningStepId: "calendar",
              source: loaded.calendarSource,
              // No binding to the hotel profile revision: the PMS read model reports the only
              // profile change the calendar uses, a new time zone, as stale (VAY-2150).
              blockers: loaded.calendarBlockers,
            },
          ],
        });
      } catch {
        return unavailableEvidence("system", "owner_read_failed");
      }
    },
    async getSnapshot(request) {
      try {
        const loaded = await load(
          dependencies,
          {
            organizationId: request.organizationId,
            propertyId: request.propertyId,
          },
          now(),
        );
        const expected = request.sourceManifest.sources.filter(
          ({ ownerDomain }) => ownerDomain === "pms",
        );
        if (
          typeof loaded === "string" ||
          !loaded.content ||
          allBlockers(loaded).length ||
          sourceKeys(loaded.sources) !== sourceKeys(expected)
        )
          return unavailableSnapshot();
        return deepFreeze({
          outcome: "snapshot",
          contractVersion: BOOKING_OWNER_SNAPSHOT_VERSION,
          owner: "pms",
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          sourceManifestHash: request.sourceManifestHash,
          resolvedSources: loaded.sources,
          content: loaded.content,
        });
      } catch {
        return unavailableSnapshot();
      }
    },
  };
}

/** Evidence, or the diagnostic code of a state no setup step can fix. */
async function load(
  dependencies: Parameters<typeof createPmsBookingPublicationSource>[0],
  scope: { organizationId: string; propertyId: string },
  observedAt: Date,
): Promise<LoadedPms | string> {
  const pricing = await dependencies.pricing.getCurrentPricingOffers(scope);
  if (
    pricing &&
    (pricing.scope.propertyId !== scope.propertyId ||
      pricing.scope.organizationId !== scope.organizationId)
  )
    return "pricing_scope_mismatch";
  // Missing or outdated prices are fixed by saving prices again (VAY-2134).
  const pricingGaps: readonly PricingGap[] = pricing
    ? []
    : await dependencies.pricing.diagnoseMissingPricing(scope.propertyId);
  if (!pricing && !pricingGaps.length) return "pricing_publication_unavailable";
  const currentCalendar =
    await dependencies.operatingCalendar.getCurrentOperatingCalendarConfiguration(scope.propertyId);
  if (currentCalendar && currentCalendar.configuration.propertyId !== scope.propertyId)
    return "calendar_scope_mismatch";
  const currentLocalDate = currentCalendar
    ? localDate(observedAt, currentCalendar.configuration.sourceInputs.propertyTimeZone)
    : null;
  if (currentCalendar && !currentLocalDate) return "calendar_time_zone_invalid";
  const [roomPublication, inventory, pricingCurrency] = await Promise.all([
    dependencies.rooms.getRoomPublicationSnapshot(scope),
    currentLocalDate
      ? dependencies.inventory.getInventoryLaunchReadiness({
          propertyId: scope.propertyId,
          requiredCoverage: { from: currentLocalDate, through: addDays(currentLocalDate, 365) },
        })
      : null,
    dependencies.pricingCurrency.getPropertyPricingCurrency(scope.propertyId),
  ]);
  const currency =
    pricingCurrency === null ? null : parsePropertyPricingCurrencySnapshot(pricingCurrency);
  // Same identity Finance's payment-methods binding expects (normalized property ID).
  const currencySource =
    currency &&
    serializePmsPricingSourceEntityRevision(
      PMS_PRICING_SOURCE_ENTITY_TYPES.propertyPricingCurrency,
      currency.propertyId,
      currency.pricingCurrencyRevision,
    );
  if (
    pricingCurrency !== null &&
    (!currency || currency.propertyId !== scope.propertyId.toLowerCase() || !currencySource)
  )
    return "pricing_currency_invalid";
  // Independent ports must not hold a pricing lock while acquiring their own connections.
  const current = pricing ? await dependencies.pricing.getCurrentPricingOffers(scope) : null;
  if (
    (pricing &&
      (!current ||
        current.sourceRevision !== pricing.sourceRevision ||
        current.scope.propertyId !== scope.propertyId ||
        current.scope.organizationId !== scope.organizationId)) ||
    roomPublication.propertyId !== scope.propertyId
  )
    return "source_changed_during_read";
  const pricingSource = pmsSource(
    "pms_pricing_publication.v2",
    scope.propertyId,
    pricing?.sourceRevision ?? `unavailable:${pricingGaps.join(",")}`,
  );
  const roomEntries = roomPublication.rooms.map((room) => ({
    source: pmsSource("pms_room_publication.v1", room.roomTypeId, room.sourceRevision),
    blockers: roomPublication.blockers
      .filter(
        ({ affectedEntity }) =>
          affectedEntity.entityType === "property" || affectedEntity.entityId === room.roomTypeId,
      )
      .map(({ code }) => blocker(code)),
  }));
  const calendarSource = currentCalendar
    ? (currentCalendar.configuration.source as PmsSource)
    : pmsSource(PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE, scope.propertyId, "absent");
  const sources: PmsSource[] = [
    pricingSource,
    ...roomEntries.map(({ source }) => source),
    ...roomPublication.rooms.map((room) =>
      pmsSource(
        "pms_room_facts.v1",
        room.roomTypeId,
        String(room.sourceRevisions.roomFactsRevision),
      ),
    ),
    calendarSource,
    ...(currencySource ? [currencySource as PmsSource] : []),
  ];
  const pricingBlockers = pricingGaps.map((gap) =>
    blocker(
      `pricing_${gap}`,
      gap === "hotel_setup_in_progress" ? "external_pending" : "user_fixable",
    ),
  );
  const inventoryMatches =
    currentCalendar &&
    inventory?.ready &&
    sourceKey(inventory.snapshot.configuration.source) ===
      sourceKey(currentCalendar.configuration.source);
  const calendarBlockers: BookingLaunchOwnerBlocker[] = !currentCalendar
    ? [blocker("operating_calendar_missing")]
    : [
        ...(inventoryMatches ? [] : [blocker("inventory_launch_readiness_incomplete")]),
        ...(currentCalendar.sourceStatus === "current"
          ? []
          : [blocker("operating_calendar_source_stale")]),
      ];
  const content =
    pricing &&
    currentCalendar &&
    currentLocalDate &&
    inventory &&
    inventoryMatches &&
    currentCalendar.sourceStatus === "current"
      ? buildPmsBookingPublicationContent({
          rooms: roomPublication.rooms,
          offers: pricing.rooms,
          inventory: inventory.snapshot,
          currentLocalDate,
          observedAt: currentCalendar.configuration.updatedAt,
        })
      : null;
  if (pricing && inventoryMatches && currentCalendar?.sourceStatus === "current" && !content)
    pricingBlockers.push(blocker("public_room_content_incomplete"));
  return {
    sources: uniqueSources(sources),
    rooms: roomEntries,
    pricingSource,
    pricingBlockers,
    calendarSource,
    calendarBlockers,
    content,
  };
}

const pmsSource = (entityType: string, entityId: string, revision: string): PmsSource => ({
  ownerDomain: "pms",
  entityType,
  entityId,
  revision,
});
const blocker = (
  code: string,
  kind: "user_fixable" | "external_pending" = "user_fixable",
): BookingLaunchOwnerBlocker => ({
  code,
  scope: "launch_configuration",
  kind,
});
const uniqueSources = (sources: readonly PmsSource[]) =>
  [...new Map(sources.map((source) => [sourceKey(source), source])).values()].sort((a, b) =>
    sourceKey(a).localeCompare(sourceKey(b)),
  );
const allBlockers = (loaded: LoadedPms) => [
  ...loaded.rooms.flatMap(({ blockers }) => blockers),
  ...loaded.pricingBlockers,
  ...loaded.calendarBlockers,
];
const sourceKeys = (sources: readonly SourceEntityRevision[]) =>
  sources.map(sourceKey).sort().join("\0");
const sourceKey = ({ ownerDomain, entityType, entityId, revision }: SourceEntityRevision) =>
  JSON.stringify([ownerDomain, entityType, entityId, revision]);
const unavailableEvidence = (errorSource: "provider" | "system", code: string) => ({
  outcome: "unavailable" as const,
  port: "pms" as const,
  errorSource,
  code,
});
const unavailableSnapshot = () => ({ outcome: "unavailable" as const, owner: "pms" as const });
const localDate = (date: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date);
  } catch {
    return null;
  }
};
const addDays = (value: string, count: number) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
