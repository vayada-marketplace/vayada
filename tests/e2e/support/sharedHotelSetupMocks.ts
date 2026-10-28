import type { Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./cors";
import type {
  AdaptiveHotelSetupStatus,
  ProductEntryDecision,
  SetupComponentProduct,
  SetupTask,
  SetupTaskId,
  SetupTrack,
  TrackStatus,
} from "@vayada/domain-hotels";

type AdaptiveHotelSetupStatusMockInput = {
  entryProduct: ProductEntryDecision["requestedProduct"];
  organizationId: string;
  organizationDisplayName: string;
  selectedTracks?: SetupTrack[];
  trackRevision?: number;
  propertyId?: string | null;
  publicId?: string;
  propertyDisplayName?: string | null;
  locationSummary?: string | null;
  entryDecision?: Partial<ProductEntryDecision> | null;
  componentAccess?: Partial<
    Record<SetupComponentProduct, TrackStatus["components"][number]["access"]>
  >;
  trackProvisioning?: Partial<Record<SetupTrack, TrackStatus["provisioning"]>>;
  taskOverrides?: Partial<Record<SetupTaskId, Partial<SetupTask>>>;
  updatedAt?: string;
};

// The plan keeps only the hotel-basics task (VAY-2175).
const TASK_DEFINITIONS: Array<
  Pick<SetupTask, "taskId" | "track" | "requirementOwnerDomain" | "destinationRouteKey">
> = [
  {
    taskId: "shared_identity",
    track: "shared",
    requirementOwnerDomain: "hotel_catalog",
    destinationRouteKey: "hotel_catalog.shared_identity",
  },
];

export function createAdaptiveHotelSetupStatusMock(
  input: AdaptiveHotelSetupStatusMockInput,
): AdaptiveHotelSetupStatus {
  const selectedTracks = canonicalTracks(input.selectedTracks ?? defaultTracks());
  const propertyId = input.propertyId === undefined ? "property-e2e" : input.propertyId;
  const selectedProperty =
    propertyId === null
      ? null
      : {
          propertyId,
          publicId: input.publicId ?? "public-property-e2e",
          displayName: input.propertyDisplayName ?? "Alpenrose Hotel",
          locationSummary: input.locationSummary ?? "Munich, DE",
        };
  const tasks =
    selectedProperty === null
      ? []
      : TASK_DEFINITIONS.filter(
          ({ track }) =>
            (track === "shared" && selectedTracks.length > 0) ||
            (track !== "shared" && selectedTracks.includes(track)),
        ).map((definition) =>
          adaptiveSetupTask(
            definition.taskId,
            selectedProperty.propertyId,
            input.taskOverrides?.[definition.taskId],
          ),
        );
  const defaultDecision: ProductEntryDecision =
    selectedProperty === null
      ? {
          requestedProduct: input.entryProduct,
          propertyId: null,
          decision: "setup_required",
          destinationRouteKey: "hotel_setup",
          reasonCode: "property_selection_required",
        }
      : {
          requestedProduct: input.entryProduct,
          propertyId: selectedProperty.propertyId,
          decision: "enter",
          destinationRouteKey: `${input.entryProduct}.workspace`,
          reasonCode: null,
        };

  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: input.organizationId,
      displayName: input.organizationDisplayName,
      websiteUrl: null,
      selectedTracks,
      trackRevision: input.trackRevision ?? 1,
      canManageTracks: true,
      tracks: [
        trackStatus(
          "hotel_operations",
          selectedTracks,
          input.componentAccess,
          input.trackProvisioning,
        ),
      ],
    },
    propertySelection:
      selectedProperty === null
        ? {
            state: "no_property",
            selectedPropertyId: null,
            availableProperties: [],
          }
        : {
            state: "single_property",
            selectedPropertyId: selectedProperty.propertyId,
            availableProperties: [selectedProperty],
          },
    entryDecision:
      input.entryDecision === null
        ? null
        : {
            ...defaultDecision,
            ...input.entryDecision,
          },
    setupPlan:
      selectedProperty === null ? null : { propertyId: selectedProperty.propertyId, tasks },
    updatedAt: input.updatedAt ?? "2026-06-30T00:00:00.000Z",
  };
}

export function adaptiveSetupTask(
  taskId: SetupTaskId,
  propertyId: string,
  overrides: Partial<SetupTask> = {},
): SetupTask {
  const definition = TASK_DEFINITIONS.find((candidate) => candidate.taskId === taskId);
  if (!definition) throw new Error(`Unknown adaptive setup task: ${taskId}`);
  return {
    ...definition,
    propertyId,
    callerCapability: "allowed",
    ownerProgress: "owner_complete",
    readiness: "complete",
    actionableBy: null,
    reasonCodes: [],
    sourceRevision: `${taskId}-e2e-1`,
    freshness: "fresh",
    evaluatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function defaultTracks(): SetupTrack[] {
  return ["hotel_operations"];
}

function canonicalTracks(tracks: readonly SetupTrack[]): SetupTrack[] {
  return (["hotel_operations"] as const).filter((track) => tracks.includes(track));
}

function trackStatus(
  track: SetupTrack,
  selectedTracks: readonly SetupTrack[],
  componentAccess: AdaptiveHotelSetupStatusMockInput["componentAccess"],
  trackProvisioning: AdaptiveHotelSetupStatusMockInput["trackProvisioning"],
): TrackStatus {
  const selected = selectedTracks.includes(track);
  const componentNames = ["pms", "booking"] as const;
  const components = componentNames.map((product) => ({
    product,
    access: componentAccess?.[product] ?? (selected ? "active" : "absent"),
  }));
  return {
    track,
    provisioning:
      trackProvisioning?.[track] ??
      (selected
        ? components.every(({ access }) => access === "active")
          ? "active"
          : "blocked"
        : "not_selected"),
    components,
    allowedActions: selected ? ["manage_service"] : ["add"],
  };
}

export async function mockHotelSetupPrerequisites(page: Page, status: AdaptiveHotelSetupStatus) {
  await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: status });
  });
}
