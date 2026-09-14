import {
  type BookingLaunchOwnerBlocker,
  type BookingLaunchPmsEvidencePort,
  type BookingLaunchSourceRevision,
} from "@vayada/domain-booking";
import {
  BOOKING_OWNER_SNAPSHOT_VERSION,
  type BookingPublicationOwnerSnapshotPort,
  type BookingPublicationSnapshotContent,
} from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import type { SourceEntityRevision } from "@vayada/domain-hotels";
import {
  type PmsInventoryLaunchReadinessReadPort,
  type PmsOperatingCalendarReadPort,
  type RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";

import type { ReplacementPricingPublicationReader } from "./replacementPricingPublicationReader.js";
import { buildPmsBookingPublicationContent } from "./pmsBookingPublicationContent.js";

type PmsSource = Omit<SourceEntityRevision, "ownerDomain"> & { ownerDomain: "pms" };
type LoadedPms = {
  sources: PmsSource[];
  rooms: readonly { source: PmsSource; blockers: BookingLaunchOwnerBlocker[] }[];
  pricingSource: PmsSource;
  pricingBlockers: BookingLaunchOwnerBlocker[];
  calendarSource: PmsSource;
  calendarBindings: BookingLaunchSourceRevision[];
  calendarBlockers: BookingLaunchOwnerBlocker[];
  content: BookingPublicationSnapshotContent["pms"] | null;
};

export function createPmsBookingPublicationSource(dependencies: {
  rooms: RoomPublicationSnapshotPort;
  pricing: ReplacementPricingPublicationReader;
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
        if (!loaded) return unavailableEvidence();
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
              blockers: loaded.calendarBlockers,
              bindings: loaded.calendarBindings.map((expectedSource) => ({
                expectedSource,
                mismatchBlocker: blocker("operating_calendar_source_stale"),
              })),
            },
          ],
        });
      } catch {
        return unavailableEvidence("system");
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
          !loaded?.content ||
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

async function load(
  dependencies: Parameters<typeof createPmsBookingPublicationSource>[0],
  scope: { organizationId: string; propertyId: string },
  observedAt: Date,
): Promise<LoadedPms | null> {
  const pricing = await dependencies.pricing.getCurrentPricingOffers(scope);
  if (
    !pricing ||
    pricing.scope.propertyId !== scope.propertyId ||
    pricing.scope.organizationId !== scope.organizationId
  )
    return null;
  const currentCalendar =
    await dependencies.operatingCalendar.getCurrentOperatingCalendarConfiguration(scope.propertyId);
  if (!currentCalendar || currentCalendar.configuration.propertyId !== scope.propertyId)
    return null;
  const currentLocalDate = localDate(
    observedAt,
    currentCalendar.configuration.sourceInputs.propertyTimeZone,
  );
  if (!currentLocalDate) return null;
  const through = addDays(currentLocalDate, 365);
  const [roomPublication, inventory] = await Promise.all([
    dependencies.rooms.getRoomPublicationSnapshot(scope),
    dependencies.inventory.getInventoryLaunchReadiness({
      propertyId: scope.propertyId,
      requiredCoverage: { from: currentLocalDate, through },
    }),
  ]);
  // Independent ports must not hold a pricing lock while acquiring their own connections.
  const current = await dependencies.pricing.getCurrentPricingOffers(scope);
  if (
    !current ||
    current.sourceRevision !== pricing.sourceRevision ||
    current.scope.propertyId !== scope.propertyId ||
    current.scope.organizationId !== scope.organizationId ||
    roomPublication.propertyId !== scope.propertyId
  )
    return null;
  const pricingSource = pmsSource(
    "pms_pricing_publication.v2",
    scope.propertyId,
    pricing.sourceRevision,
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
    currentCalendar.configuration.source as PmsSource,
  ];
  const pricingBlockers: BookingLaunchOwnerBlocker[] = [];
  const inventoryMatches =
    inventory?.ready &&
    sourceKey(inventory.snapshot.configuration.source) ===
      sourceKey(currentCalendar.configuration.source);
  const calendarBlockers: BookingLaunchOwnerBlocker[] = [
    ...(inventoryMatches ? [] : [blocker("inventory_launch_readiness_incomplete")]),
    ...(currentCalendar.sourceStatus === "current"
      ? []
      : [blocker("operating_calendar_source_stale")]),
  ];
  const content =
    inventoryMatches && currentCalendar.sourceStatus === "current"
      ? buildPmsBookingPublicationContent({
          rooms: roomPublication.rooms,
          offers: pricing.rooms,
          inventory: inventory.snapshot,
          currentLocalDate,
          observedAt: currentCalendar.configuration.updatedAt,
        })
      : null;
  if (inventoryMatches && currentCalendar.sourceStatus === "current" && !content)
    pricingBlockers.push(blocker("public_room_content_incomplete"));
  return {
    sources: uniqueSources(sources),
    rooms: roomEntries,
    pricingSource,
    pricingBlockers,
    calendarSource: currentCalendar.configuration.source as PmsSource,
    calendarBindings: [currentCalendar.configuration.sourceInputs.propertyProfile],
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
const blocker = (code: string): BookingLaunchOwnerBlocker => ({
  code,
  scope: "launch_configuration",
  kind: "user_fixable",
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
const unavailableEvidence = (errorSource: "provider" | "system" = "provider") => ({
  outcome: "unavailable" as const,
  port: "pms" as const,
  errorSource,
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
