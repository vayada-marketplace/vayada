import { createHash, randomUUID } from "node:crypto";

import Fastify from "fastify";
import type { RequestContext } from "@vayada/backend-auth";
import { createPgPropertyAccessRepository } from "@vayada/backend-authorization";
import {
  createBookingDesignReadinessProvider,
  type ReadyBookingPublicationEvidence,
} from "@vayada/domain-booking";
import { parseReplaceFinancePaymentMethodsCommand } from "@vayada/domain-finance";
import {
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  createHotelCatalogStep1MediaAssignments,
  createHotelMediaResolutionPort,
  type ProductReadinessResult,
  type ReadinessProviderFailure,
} from "@vayada/domain-hotels";
import {
  parseAssignRoomTypeMediaCommand,
  parseConfirmRoomTypeAmenitiesCommand,
  parseCreateRoomTypeFactsCommand,
  parsePreviewPmsOperatingCalendarImpactCommand,
  parseReconcilePhysicalRoomUnitsCommand,
  parseSetPhysicalRoomOperationalLabelCommand,
  parseUpdateRoomTypeFactsCommand,
  parseUpsertPmsOperatingCalendarCommand,
  parseUpsertPropertyPricingCurrencyCommand,
  type RoomTypeFacts,
} from "@vayada/domain-pms";
import pg from "pg";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createPgBookingDesignCatalogEvidenceRepository } from "./domains/bookingDesignCatalogEvidenceRepository.js";
import { createPgBookingDesignRepository } from "./domains/bookingDesignRepository.js";
import { createBookingGuestChoicePublicationReader } from "./domains/bookingGuestChoicePublication.js";
import { createBookingGuestChoiceStore } from "./domains/bookingGuestChoiceStore.js";
import { createBookingGuestTermsStore } from "./domains/bookingGuestTermsStore.js";
import { createPgBookingGuestPolicyScopeAuthorizationPort } from "./domains/bookingGuestPolicyScopeAuthorization.js";
import { catchUpLiveBookingPages } from "./domains/bookingLivePageCatchUp.js";
import {
  BookingPublicationNotReadyError,
  createBookingPublicationProductionRuntime,
} from "./domains/bookingPublicationProductionRuntime.js";
import { createPgFinancePaymentReadinessCommandRepository } from "./domains/financePaymentReadinessCommandRepository.js";
import { createFinanceSubscriptionService } from "./domains/financeSubscriptionService.js";
import { configureActiveBookingPublicationGate } from "./domains/activeBookingPublicationGate.js";
import { createFinanceManualPaymentReadinessReader } from "./domains/financeManualPaymentReadiness.js";
import { createPgFinanceSubscriptionStore } from "./domains/financeSubscriptionStore.js";
import { createPgFinancePaymentReadinessReadModel } from "./domains/financePaymentReadinessReadModel.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgHotelCatalogStep1Repository } from "./domains/hotelCatalogStep1Repository.js";
import { createPgHotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgPlatformPropertyLifecycleCommandRepository } from "./domains/platformPropertyLifecycleCommandRepository.js";
import { processNextPmsAcceptedPricingReservationJob } from "./domains/pmsAcceptedPricingReservationWorker.js";
import { createTargetPmsInventoryReservationPort } from "./domains/pmsInventoryReservation.js";
import { createManualBookingPricingPublicationReader } from "./domains/pmsManualBookingTransactionalPricing.js";
import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./domains/pmsOperationsReadModel.js";
import { createPgPmsOperatingCalendarReadModel } from "./domains/pmsOperatingCalendarReadModel.js";
import {
  findPmsOperatingCalendarRoomRefreshCandidates,
  followRoomChangesInCalendar,
  repairPmsOperatingCalendarRooms,
  type PmsOperatingCalendarRoomRefreshPorts,
} from "./domains/pmsOperatingCalendarRoomRefresh.js";
import { createPmsOperatingCalendarProductionRuntime } from "./domains/pmsOperatingCalendarProductionRuntime.js";
import { createPgPmsPhysicalRoomOperationalLabelRepository } from "./domains/pmsPhysicalRoomOperationalLabelRepository.js";
import { createPgPmsPhysicalRoomUnitReconcileRepository } from "./domains/pmsPhysicalRoomUnitReconcileRepository.js";
import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD } from "./domains/pmsPricingCurrencyCapabilities.js";
import { createPgPmsPricingReadModel } from "./domains/pmsPricingReadModel.js";
import { createTargetPmsRoomInventoryReadPort } from "./domains/pmsRoomInventoryReadModel.js";
import { createPmsRoomAmenityVocabularyValidationPort } from "./domains/pmsRoomAmenityVocabulary.js";
import { createPgPmsRoomFactsCommandRepository } from "./domains/pmsRoomFactsCommandRepository.js";
import { createPgPmsRoomFactsReadModel } from "./domains/pmsRoomFactsReadModel.js";
import { createPmsRoomFactsVocabularyValidationPort } from "./domains/pmsRoomFactsVocabulary.js";
import { createPgPmsRoomPublicationCommandRepository } from "./domains/pmsRoomPublicationCommandRepository.js";
import { createPmsBookingPublicationSource } from "./domains/pmsBookingPublicationSource.js";
import { createPgPmsRoomPublicationReadModel } from "./domains/pmsRoomPublicationReadModel.js";
import { createPgS3PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";
import { lockPublicPricingAuthority } from "./domains/publicPricingAuthority.js";
import { createReplacementPricingCommands } from "./domains/replacementPricingCommands.js";
import { createReplacementPricingPublicationReader } from "./domains/replacementPricingPublicationReader.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { registerFinanceSubscriptionRoutes } from "./routes/financeSubscriptions.js";
import { externalBookingChanges } from "./integrations/externalBookingChanges.js";
import { createPgHotelMediaResolutionPort } from "./platform/hotelMediaResolver.js";
import { writeOrdinaryHotelSetupPropertyProfile } from "./platform/hotelSetupProfileWriter.js";
import type { PlatformMediaServingConfig } from "./platform/mediaServing.js";
import {
  advancePublicProfileRevision,
  createPgSharedHotelSetupStatusRepository,
} from "./platform/sharedHotelSetupStatusReadModel.js";
import { createPublicRuntimeRepositories } from "./publicRuntime.js";
import { createActiveBookingPublicationProfileRepository } from "./routes/activeBookingPublicationProfile.js";
import type { BookingAddonItemsContext } from "./routes/bookingAddonItems.js";
import { calculateManualBookingPreview } from "./routes/pmsManualBookingPreviewCalculation.js";
import {
  createTargetBookingWebCheckoutAdapter,
  registerBookingWebPublicRoutes,
} from "./routes/bookingWebPublic.js";
import { projectPropertyPublicProfile } from "./platform/propertyPublicProfileProjection.js";
import { createPropertySlugChangeCommand } from "./domains/propertySlugChange.js";
import { createTargetFinancePropertySettingsRepository } from "./routes/finance.js";

const url = process.env["TEST_DATABASE_URL"];
const TIME_ZONE = "Asia/Colombo";
const serving: PlatformMediaServingConfig = {
  bucketName: "vayada-media-test",
  cdnBaseUrl: "https://cdn.example.test",
  cdnOriginHost: "vayada-media-test.s3.example.test",
  publicPathPrefix: "media",
  publicCacheControl: "public, max-age=31536000, immutable",
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
};
const SUMMARY =
  "A calm beach hotel in Galle with garden suites, slow breakfasts and a quiet pool by the sea.";

type Readiness = ProductReadinessResult | ReadinessProviderFailure;

/** Every blocker as `group:code`, or the provider failure, for readable assertions. */
function blockerCodes(readiness: Readiness): string[] {
  if (readiness.outcome !== "evaluated") return [`provider_failure:${readiness.error.code}`];
  return readiness.groups
    .flatMap((group) =>
      group.steps.flatMap((step) =>
        step.entities.flatMap((entity) =>
          entity.blockers.map((blocker) => `${group.groupId}:${blocker.code}`),
        ),
      ),
    )
    .sort();
}

function localDate(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE }).format(new Date());
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** Eleven closed nights at least 100 days out, as the one open period around them (VAY-2469). */
function closedSeason() {
  for (let offset = 100; ; offset += 1) {
    const days = Array.from({ length: 13 }, (_, index) => localDate(offset - 1 + index));
    // The schedule has no 29 February.
    if (days.some((day) => day.endsWith("-02-29"))) continue;
    return {
      nights: days.slice(1, 12),
      periods: [{ startsOn: days[12]!.slice(5), endsOn: days[0]!.slice(5) }],
    };
  }
}

function ok<T extends { ok: boolean }>(result: T, step: string): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`${step} failed: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function parsed<T>(value: T | null, step: string): T {
  if (!value) throw new Error(`${step} command is invalid`);
  return value;
}

/**
 * VAY-2134: walks a brand-new self-serve hotel through adaptive setup with the real owner
 * commands, on the production-shaped API login, and replays the TEST ONLY history: payments
 * first saved through the older settings page, and a room added the day after the calendar
 * was prepared. Readiness must explain every gap and end `ready` with a published page.
 * VAY-2140: no Vayada activation step; a suspended hotel can't publish or sell.
 * VAY-2139 walks the same hotel paid only by bank transfer or only by PayPal, with their
 * acceptance on: the page publishes with that method and stops counting once it is off.
 * VAY-2171: publishing waits for a billing plan. The owner confirms Commission through
 * POST /api/finance/properties/:id/select-commission, and a guest's pay-at-hotel request is then
 * accepted.
 */
const METHODS = ["pay_at_property", "bank_transfer", "paypal"] as const;
const BOTH = ["bank_transfer", "paypal"] as const;
const WALK = { timeout: 300_000 };
describe.skipIf(!url)("new hotel setup to a published booking page (VAY-2134)", WALK, () => {
  it.each(METHODS)("walks setup to ready and publishes the booking page (%s)", async (method) => {
    const manualMethod = method === "pay_at_property" ? null : method;
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const login = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const cs = login.connectionString;
    const closers: (() => Promise<unknown>)[] = [];
    const closing = <T extends { close(): Promise<unknown> }>(value: T): T => {
      closers.push(() => value.close());
      return value;
    };
    const pool = new pg.Pool({ connectionString: cs, max: 6 });
    closers.push(() => pool.end());

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const [organizationId, owner, membershipId] = [randomUUID(), randomUUID(), randomUUID()];
    const [platformOrganizationId, platformAdmin] = [randomUUID(), randomUUID()];
    const now = () => new Date().toISOString();
    const commandAudit = (step: string) => ({
      actor: { kind: "user" as const, userId: owner },
      requestId: `${step}-${suffix}`,
      correlationId: `${step}-${suffix}`,
      requestedAt: now(),
    });
    const requestAudit = (step: string) => ({
      requestId: `${step}-${suffix}`,
      correlationId: `${step}-${suffix}`,
      source: "web" as const,
      receivedAt: now(),
    });
    const unavailable: unknown[] = [];

    try {
      // Signup: an owner account with a hotel-group organization.
      await admin.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
        owner,
        `owner-${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'hotel_group','Walk hotels',$2,'active')",
        [organizationId, `walk-${suffix}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_memberships
           (id,organization_id,user_id,status,role_key,access_origin,property_access_mode)
         VALUES($1,$2,$3,'active','hotel_owner','agency','all')`,
        [membershipId, organizationId, owner],
      );

      // Owner-side ports, composed like server.ts.
      const mediaAdapter = createPgHotelMediaResolutionPort({ connectionString: cs, serving });
      closers.push(async () => mediaAdapter.close?.());
      const mediaResolver = createHotelMediaResolutionPort(mediaAdapter);
      const roomFacts = closing(createPgPmsRoomFactsReadModel({ connectionString: cs }));
      const amenityVocabulary = createPmsRoomAmenityVocabularyValidationPort();
      const pricingRead = closing(createPgPmsPricingReadModel({ connectionString: cs }));
      const designRepository = closing(createPgBookingDesignRepository({ connectionString: cs }));
      const catalogEvidence = closing(
        createPgBookingDesignCatalogEvidenceRepository({ connectionString: cs, mediaResolver }),
      );
      const profileEvidence = closing(
        createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({ connectionString: cs }),
      );
      const operatingCalendar = closing(
        createPgPmsOperatingCalendarReadModel({
          connectionString: cs,
          propertyProfileEvidence: closing(
            createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
              connectionString: cs,
              readOnly: true,
            }),
          ),
          roomEvidence: { roomFacts, roomCapacity: roomFacts },
        }),
      );
      const calendar = createPmsOperatingCalendarProductionRuntime({
        enabled: true,
        connectionString: cs,
        confirmationSecret: "vay2134-walk-confirmation-secret-0000",
        authorizationPool: pool,
        propertyProfileEvidence: profileEvidence,
        roomEvidence: { roomFacts, roomCapacity: roomFacts },
        operatingCalendar,
      });
      if (!calendar) throw new Error("Calendar runtime is disabled");
      closers.push(() => calendar.close());
      const financeRead = closing(
        createPgFinancePaymentReadinessReadModel({
          connectionString: cs,
          pricingReadPort: pricingRead,
        }),
      );
      const runtime = createBookingPublicationProductionRuntime({
        connectionString: cs,
        bookingHostBase: "booking.example.test",
        mediaResolver,
        design: createBookingDesignReadinessProvider({
          design: designRepository,
          profile: catalogEvidence.profile,
          coverAssignment: catalogEvidence.coverAssignment,
          safeMedia: catalogEvidence.safeMedia,
        }),
        guestRules: createBookingGuestChoicePublicationReader(pool),
        rooms: closing(
          createPgPmsRoomPublicationReadModel({
            connectionString: cs,
            roomFacts,
            roomCapacity: roomFacts,
            amenityVocabulary,
            mediaResolver,
          }),
        ),
        pricing: createReplacementPricingPublicationReader(pool),
        pricingCurrency: pricingRead,
        operatingCalendar,
        inventory: calendar.inventory,
        finance: financeRead,
        financeScope: financeRead,
        // Bank transfer and PayPal count only while their acceptance is on (VAY-2139).
        ...(manualMethod
          ? {
              manualPayments: createFinanceManualPaymentReadinessReader({ pool, methods: BOTH }),
              manualMethods: BOTH,
            }
          : {}),
        warn: (fields) => unavailable.push(fields),
      });
      closers.push(() => runtime.close());
      closers.push(async () => runtime.routes.repository.close?.());

      // 1. Choose the hotel-operations track, then create the hotel (VAY-2056 self-serve).
      const tracks = closing(createPgHotelSetupTrackCommandRepository({ connectionString: cs }));
      ok(
        await tracks.updateTracks({
          organizationId,
          actorUserId: owner,
          idempotencyKey: `tracks-${suffix}`,
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          audit: requestAudit("tracks"),
        }),
        "track selection",
      );
      const creation = createPgSharedHotelSetupStatusRepository({
        connectionString: cs,
        pool,
        hotelSetupOwnerCreation: true,
      });
      const created = await creation.createPropertyProfile({
        organizationId,
        idempotencyKey: `create-${suffix}`,
        correlationId: `create-${suffix}`,
        profile: {
          displayName: "Walk Beach Hotel",
          propertyType: "hotel",
          // Like the setup form: the basics (VAY-2247) include the street and both contacts.
          contacts: [
            {
              channelType: "email",
              value: "reception@walk.example.test",
              purpose: "general",
              isPublic: true,
            },
            { channelType: "phone", value: "+94 91 222 3344", purpose: "general", isPublic: true },
          ],
          location: {
            countryCode: "LK",
            city: "Galle",
            streetAddress: "Lighthouse Street 12",
            postalCode: "",
            timezone: TIME_ZONE,
            latitude: null,
            longitude: null,
            localityPublic: false,
            geoPublic: false,
            mapDisplayMode: "hidden",
          },
        },
        audit: { actorUserId: owner, requestId: `create-${suffix}`, receivedAt: now() },
      });
      const propertyId = created.propertyId;
      const scope = { organizationId, propertyId };
      const readiness = () => runtime.routes.readinessProvider.getBookingReadiness(scope);

      // A brand-new hotel gets a to-do list, never "temporarily unavailable".
      expect(await financeRead.hasPaymentReadinessScope(scope)).toBe(true);
      expect(
        await financeRead.hasPaymentReadinessScope({ ...scope, organizationId: randomUUID() }),
      ).toBe(false);
      const fresh = await readiness();
      expect(blockerCodes(fresh)).toEqual(
        expect.arrayContaining([
          "booking.calendar:operating_calendar_missing",
          "booking.guest_experience:guest_policy_not_configured",
          // VAY-2247: the basics are complete at creation; the hotel goes live once "Present your
          // hotel" adds a description and a photo, so that is what's asked for.
          "booking.hotel_profile:hotel_setup_content_missing",
          "booking.page_style:booking_design_missing",
          "booking.payments:billing_plan_not_selected",
          "booking.payments:payment_methods_not_configured",
          "booking.pricing:pricing_not_published",
          "booking.rooms:publishable_room_required",
        ]),
      );
      // VAY-2288: a private city and country ask for "Show city and country publicly", and the
      // setup profile save that ticks it clears the item.
      expect(blockerCodes(fresh)).toContain("booking.hotel_profile:hotel_public_locality_hidden");
      expect(blockerCodes(fresh)).not.toContain(
        "booking.hotel_profile:hotel_public_locality_missing",
      );
      const localityRevision = Number(
        (
          await admin.query("SELECT profile_revision FROM hotel_catalog.properties WHERE id=$1", [
            propertyId,
          ])
        ).rows[0]!.profile_revision,
      );
      const locality = await writeOrdinaryHotelSetupPropertyProfile(
        pool,
        { propertyId, organizationId, actorUserId: owner },
        `locality-${suffix}`,
        {
          idempotencyKey: `locality-${suffix}`,
          fingerprint: createHash("sha256").update(`locality-${suffix}`).digest("hex"),
          merge: (existing) => ({
            expectedProfileRevision: localityRevision,
            profile: { ...existing, location: { ...existing.location, localityPublic: true } },
          }),
        },
      );
      expect(locality.status).toBe("updated");
      expect(blockerCodes(await readiness())).not.toContain(
        "booking.hotel_profile:hotel_public_locality_hidden",
      );

      // 2. Present your hotel: summary plus an uploaded cover photo (Step 1 route flow).
      const coverId = randomUUID();
      await insertStagedPhoto(admin, coverId, { organizationId, propertyId, owner });
      const step1 = closing(createPgHotelCatalogStep1Repository({ connectionString: cs }));
      const media = closing(
        createPgS3PropertyMediaCommandRepository({
          connectionString: cs,
          serving,
          syncReadModels: projectPropertyPublicProfile,
          publisher: { copyToPublic: async () => {}, deletePublic: async () => {} },
        }),
      );
      const profileRevision = async () =>
        Number(
          (
            await admin.query("SELECT profile_revision FROM hotel_catalog.properties WHERE id=$1", [
              propertyId,
            ])
          ).rows[0]!.profile_revision,
        );
      const presentHotel = async (step: string, shortDescription: string) => {
        const presentKey = `${step}-${suffix}`;
        const presentCommand = {
          organizationId,
          propertyId,
          actorUserId: owner,
          idempotencyKey: presentKey,
          audit: requestAudit(step),
          request: {
            expectedProfileRevision: await profileRevision(),
            locale: "en" as const,
            shortDescription,
            amenities: { reviewed: true as const, keys: [] },
            media: { coverMediaObjectId: coverId, galleryMediaObjectIds: [] },
          },
        };
        const prepared = await step1.prepare(presentCommand);
        if (prepared.kind !== "prepared") throw new Error(`present: ${JSON.stringify(prepared)}`);
        const presentation = ok(
          await media.replacePresentation({
            organizationId,
            propertyId,
            actorUserId: owner,
            audit: presentCommand.audit,
            idempotencyKey: `hotel-catalog-step1-media:${createHash("sha256").update(presentKey).digest("hex")}`,
            expectedProfileRevision: presentCommand.request.expectedProfileRevision,
            assignments: createHotelCatalogStep1MediaAssignments(
              presentCommand.request.media,
              prepared.state.readModel.displayName,
            ),
          }),
          "hotel photo",
        );
        ok(
          await step1.save({
            ...presentCommand,
            claimToken: prepared.claimToken,
            writeProfileRevision: presentation.response.profileRevision,
          }),
          "present your hotel",
        );
      };
      await presentHotel("present", SUMMARY);
      // VAY-2140: completing the profile activates the hotel; nobody at Vayada approves it.
      expect(
        (
          await admin.query(
            `SELECT property.lifecycle_status AS status, count(audit.id)::int AS audits
             FROM hotel_catalog.properties property
             LEFT JOIN platform.product_audit_events audit ON audit.property_id = property.id
               AND audit.action = 'hotel_catalog.property.lifecycle.auto_activate'
             WHERE property.id = $1 GROUP BY property.lifecycle_status`,
            [propertyId],
          )
        ).rows,
      ).toEqual([{ status: "active", audits: 1 }]);

      // 3. Style your booking page.
      ok(
        await designRepository.upsertDesign({
          organizationId,
          propertyId,
          actorUserId: owner,
          idempotencyKey: `design-${suffix}`,
          expectedRevision: 0,
          choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
          audit: {
            requestId: `design-${suffix}`,
            correlationId: `design-${suffix}`,
            source: "web",
          },
        }),
        "booking design",
      );

      // 4. Add your room types: the room-facts command, units, labels, photo and amenities.
      const rooms = {
        facts: closing(
          createPgPmsRoomFactsCommandRepository({
            connectionString: cs,
            vocabularyValidator: createPmsRoomFactsVocabularyValidationPort(),
          }),
        ),
        units: closing(createPgPmsPhysicalRoomUnitReconcileRepository({ connectionString: cs })),
        labels: closing(
          createPgPmsPhysicalRoomOperationalLabelRepository({ connectionString: cs }),
        ),
        publication: closing(
          createPgPmsRoomPublicationCommandRepository({
            connectionString: cs,
            mediaResolver,
            amenityVocabulary,
          }),
        ),
      };
      const addRoom = async (name: string, draftRoomId: string) => {
        const createdRoom = ok(
          await rooms.facts.createRoomTypeFacts(
            parsed(
              parseCreateRoomTypeFactsCommand({
                organizationId,
                propertyId,
                draftRoomId,
                expectedRevision: 0,
                facts: roomFacts2(name),
                idempotencyKey: `facts-${draftRoomId}-${suffix}`,
                audit: commandAudit(`facts-${draftRoomId}`),
              }),
              "room facts",
            ),
          ),
          "room facts",
        );
        const roomTypeId = createdRoom.response.roomType.roomTypeId;
        const reconciled = ok(
          await rooms.units.reconcilePhysicalRoomUnits(
            parsed(
              parseReconcilePhysicalRoomUnitsCommand({
                organizationId,
                propertyId,
                roomTypeId,
                expectedRevision: 1, // a new room type starts at units revision 1
                targetActiveUnitCount: 2,
                idempotencyKey: `units-${draftRoomId}-${suffix}`,
                audit: commandAudit(`units-${draftRoomId}`),
              }),
              "room units",
            ),
          ),
          "room units",
        );
        let unitsRevision = reconciled.response.capacity.roomUnitsRevision;
        for (const [index, unit] of reconciled.response.addedUnits.entries()) {
          const labelled = ok(
            await rooms.labels.setPhysicalRoomOperationalLabel(
              parsed(
                parseSetPhysicalRoomOperationalLabelCommand({
                  organizationId,
                  propertyId,
                  roomTypeId,
                  roomUnitId: unit.roomUnitId,
                  expectedRevision: unitsRevision,
                  operationalLabel: `${draftRoomId.slice(-1).toUpperCase()}-${101 + index}`,
                  idempotencyKey: `label-${draftRoomId}-${index}-${suffix}`,
                  audit: commandAudit(`label-${draftRoomId}-${index}`),
                }),
                "room label",
              ),
            ),
            "room label",
          );
          unitsRevision = labelled.response.roomUnitsRevision;
        }
        const photoId = randomUUID();
        await insertPublicPhoto(admin, photoId, { organizationId, propertyId, owner });
        ok(
          await rooms.publication.assignRoomTypeMedia(
            parsed(
              parseAssignRoomTypeMediaCommand({
                organizationId,
                propertyId,
                roomTypeId,
                expectedRoomMediaRevision: 1,
                assignments: [{ mediaObjectId: photoId, altText: name, sortOrder: 0 }],
                idempotencyKey: `room-media-${draftRoomId}-${suffix}`,
                audit: commandAudit(`room-media-${draftRoomId}`),
              }),
              "room media",
            ),
          ),
          "room media",
        );
        ok(
          await rooms.publication.confirmRoomTypeAmenities(
            parsed(
              parseConfirmRoomTypeAmenitiesCommand({
                organizationId,
                propertyId,
                roomTypeId,
                expectedRoomAmenitiesRevision: 1,
                amenities: ["wifi", "air_conditioning"],
                idempotencyKey: `room-amenities-${draftRoomId}-${suffix}`,
                audit: commandAudit(`room-amenities-${draftRoomId}`),
              }),
              "room amenities",
            ),
          ),
          "room amenities",
        );
        return roomTypeId;
      };
      const gardenSuite = await addRoom("Garden Suite", "setup-room-a");

      // 5. Property currency, then payments through the older settings page like TEST ONLY.
      const currency = closing(
        createPgPmsPricingCommandRepository({
          connectionString: cs,
          pool,
          hotelSetupOrdinaryOwner: true,
          currencyChangeGuard: PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD,
        }),
      );
      const currencySaved = ok(
        await currency.upsertPropertyPricingCurrency(
          parsed(
            parseUpsertPropertyPricingCurrencyCommand({
              organizationId,
              propertyId,
              currency: "EUR",
              expectedPricingCurrencyRevision: 0,
              idempotencyKey: `currency-${suffix}`,
              audit: commandAudit("currency"),
            }),
            "currency",
          ),
        ),
        "currency",
      );
      const legacyPool = new pg.Pool({ connectionString: cs, max: 2 });
      closers.push(() => legacyPool.end());
      if (manualMethod === "bank_transfer")
        // TEST ONLY: production saves bank details, KMS-encrypted, through Booking Engine
        // settings > Payments. The settings page then requires an enabled destination.
        await admin.query(
          `INSERT INTO finance.bank_transfer_destinations(property_id,revision,ciphertext,key_arn,account_last4)
           VALUES($1,1,$2,'arn:aws:kms:eu-central-1:000000000000:key/walk','3000')`,
          [propertyId, Buffer.alloc(40)],
        );
      expect(
        await createTargetFinancePropertySettingsRepository({
          connectionString: cs,
          pool: legacyPool,
        }).updatePaymentSettings!({
          commandType: "finance.payment_settings.update",
          commandId: randomUUID(),
          idempotencyKey: `legacy-payments-${suffix}`,
          propertyId,
          audit: {
            actor: { kind: "user", userId: owner, organizationId },
            requestId: `legacy-payments-${suffix}`,
            correlationId: `legacy-payments-${suffix}`,
            reason: "Payments saved from the settings page",
            requestedAt: now(),
          },
          payload: manualMethod
            ? {
                paymentsEnabled: true,
                acceptedMethods: [manualMethod],
                ...(manualMethod === "paypal"
                  ? { depositPolicy: { paypalEmail: `pay-${suffix}@example.test` } }
                  : {}),
              }
            : { paymentsEnabled: true, acceptedMethods: ["pay_at_property", "cash"] },
        }),
      ).toMatchObject({ ok: true });
      // Before VAY-2134 this was "temporarily unavailable". Since VAY-2136 the settings page
      // writes the same versioned row as the setup step, so TEST ONLY's save counts.
      expect(blockerCodes(await readiness())).not.toContain(
        "booking.payments:payment_methods_not_configured",
      );
      const paymentMethodsRevision = Number(
        (
          await admin.query(
            "SELECT payment_methods_revision FROM finance.payment_settings WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0]!.payment_methods_revision,
      );
      expect(paymentMethodsRevision).toBeGreaterThan(0);
      const payments = closing(
        createPgFinancePaymentReadinessCommandRepository({
          connectionString: cs,
          max: 2,
          pricingReadPort: pricingRead,
        }),
      );
      if (manualMethod) {
        // A hotel paid only by bank transfer or PayPal selects no setup readiness method; the
        // settings page save above is its payment choice (VAY-2139).
        expect(blockerCodes(await readiness())).not.toContain(
          "booking.payments:ready_payment_method_missing",
        );
      } else {
        ok(
          await payments.replacePaymentMethods({
            command: parsed(
              parseReplaceFinancePaymentMethodsCommand({
                organizationId,
                propertyId,
                idempotencyKey: `payments-${suffix}`,
                expectedPaymentMethodsRevision: paymentMethodsRevision,
                expectedPricingCurrencyRevision:
                  currencySaved.response.pricingCurrency.pricingCurrencyRevision,
                selectedMethods: ["pay_at_property"],
                audit: commandAudit("payments"),
              }),
              "payments",
            ),
            currentPricing: null,
          }),
          "setup payments",
        );
      }

      // 6. Set your room prices (pricing-v2 draft, charges, publish).
      const context: RequestContext = {
        actor: {
          internalUserId: owner,
          email: `owner-${suffix}@example.test`,
          status: "active",
          providerIdentity: { provider: "workos", providerUserId: `user-${suffix}` },
        },
        selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
        membership: {
          membershipId,
          roleKey: "hotel_owner",
          status: "active",
          permissions: ["pms.rooms_rates.read", "pms.rooms_rates.manage"],
          workosRoleSlugs: [],
        },
        linkedResources: [
          {
            product: "pms",
            resourceType: "pms_property",
            resourceId: propertyId,
            relationship: "owner",
            status: "active",
          },
        ],
        entitlements: [{ product: "pms", key: "property-management", status: "active" }],
        locale: "en",
        currency: "EUR",
        audit: requestAudit("pricing"),
      } as RequestContext;
      const pricing = createReplacementPricingCommands(pool, context);
      // Like the Prices step, terms are staged only for rooms that have none yet.
      const termsByRoom = new Map<string, string>();
      const savePrices = async (roomTypeIds: readonly string[], revision: number) => {
        const draftId = randomUUID();
        const draft = { draftId, baseRevision: revision - 1 };
        const priced = [];
        for (const roomTypeId of roomTypeIds) {
          if (!termsByRoom.has(roomTypeId)) {
            const terms = await pricing.stageTerms(
              propertyId,
              {
                requestId: randomUUID(),
                expectedRevision: null,
                terms: {
                  roomTypeId,
                  offerId: "standard",
                  // Non-refundable stays are paid in advance, so the pay-at-hotel walk books a free-cancellation
                  // rate (VAY-2280 refuses non-refundable terms that accept pay at property).
                  cancellation:
                    method === "pay_at_property"
                      ? {
                          kind: "flexible",
                          terms: {
                            type: "free_until_days_before_arrival",
                            freeCancellationDeadlineDays: 7,
                            afterDeadlinePenalty: "full_booking_amount",
                            noShowPenalty: "full_booking_amount",
                          },
                        }
                      : { kind: "non_refundable" },
                  payment: { kind: "full", acceptedMethods: [method] },
                },
              },
              draft,
            );
            termsByRoom.set(roomTypeId, terms.revision);
          }
          priced.push(roomPrice(propertyId, roomTypeId, revision, termsByRoom.get(roomTypeId)!));
        }
        const preparedPrices = await pricing.prepare(
          propertyId,
          { currency: "EUR", rooms: priced },
          draft,
        );
        expect(
          await pricing.saveDraft(propertyId, {
            draftId,
            expectedDraftRevision: 0,
            baseRevision: revision - 1,
            ...preparedPrices,
          }),
        ).toBe(1);
        const review = (await pricing.reviewCharges(propertyId, draftId))!;
        const charges = await pricing.confirmCharges(propertyId, {
          draftId,
          expectedDraftRevision: 1,
          claimedFingerprint: review.fingerprint,
          declaration: "all_mandatory_charges_included",
          declaredVia: "save_prices",
          requestId: randomUUID(),
        });
        const snapshot = {
          ...review.snapshot,
          ownerReferences: { ...review.snapshot.ownerReferences, charges: charges.id },
        };
        expect(
          await pricing.saveDraft(propertyId, {
            draftId,
            expectedDraftRevision: 1,
            baseRevision: revision - 1,
            sources: review.sources,
            effectiveSources: review.effectiveSources!,
            snapshot,
          }),
        ).toBe(2);
        expect(
          await pricing.publish(propertyId, {
            requestId: randomUUID(),
            expectedRevision: revision - 1,
            sources: review.sources,
            effectiveSources: review.effectiveSources!,
            snapshot,
            draft: { id: draftId, revision: 2 },
          }),
        ).toEqual({ revision, replayed: false });
      };
      await savePrices([gardenSuite], 1);

      // 7. Configure the guest experience.
      const guestChoices = createBookingGuestChoiceStore(pool, (client) =>
        createPgBookingGuestPolicyScopeAuthorizationPort({ pool: client }),
      );
      await guestChoices.save(
        { propertyId, organizationId, actorUserId: owner },
        {
          requestId: `guest-${suffix}`,
          expectedRevision: null,
          confirmed: true,
          choices: {
            defaultGuestLanguage: "en",
            childrenEnabled: true,
            adultAgeThreshold: 18,
            phoneRequired: true,
            arrivalTimeEnabled: false,
            specialRequestsEnabled: true,
            checkInTime: "15:00",
            checkOutTime: "11:00",
            checkInUntil: "23:00",
          },
        },
      );
      // The setup Guest step also saves the default guest terms, without touching the hotel
      // profile revision the earlier steps' drafts were saved against (VAY-2176).
      const profileBeforeTerms = await profileRevision();
      await createBookingGuestTermsStore(pool, (client) =>
        createPgBookingGuestPolicyScopeAuthorizationPort({ pool: client }),
      ).save({ propertyId, organizationId, actorUserId: owner }, "Our guest terms.", null);
      expect(await profileRevision()).toBe(profileBeforeTerms);

      // 8. Open your calendar. The first save happened "yesterday" in the hotel's time zone.
      const saveCalendarRevision = async (
        roomTypeIds: readonly string[],
        expectedCalendarRevision: number,
      ) => {
        const roomRows = (
          await admin.query(
            "SELECT id::text,room_facts_revision,room_units_revision FROM pms.room_types WHERE id=ANY($1::uuid[]) ORDER BY id::text",
            [roomTypeIds],
          )
        ).rows;
        const proposal = {
          organizationId,
          propertyId,
          expectedCalendarRevision,
          expectedPropertyProfileRevision: await profileRevision(),
          schedule: { mode: "year_round", periods: [] },
          defaultMinimumStayNights: 1,
          roomTypeLimits: roomRows.map((row) => ({
            roomTypeId: row.id,
            expectedRoomFactsRevision: Number(row.room_facts_revision),
            expectedRoomUnitsRevision: Number(row.room_units_revision),
            startingSellableLimitCount: 2,
          })),
        };
        const preview = ok(
          await calendar.routes.impactPreviewPort.previewOperatingCalendarImpact(
            parsed(
              parsePreviewPmsOperatingCalendarImpactCommand({
                ...proposal,
                audit: commandAudit(`calendar-preview-${expectedCalendarRevision}`),
              }),
              "calendar preview",
            ),
          ),
          "calendar preview",
        );
        return ok(
          await calendar.routes.commandPort.upsertOperatingCalendar(
            parsed(
              parseUpsertPmsOperatingCalendarCommand({
                ...proposal,
                impactConfirmation: preview.preview.confirmation,
                idempotencyKey: `calendar-${expectedCalendarRevision}-${suffix}`,
                audit: commandAudit(`calendar-${expectedCalendarRevision}`),
              }),
              "calendar save",
            ),
          ),
          "calendar save",
        ).response.configuration;
      };
      const prepareCalendar = (
        configuration: Awaited<ReturnType<typeof saveCalendarRevision>>,
        horizon: { from: string; through: string },
      ) =>
        calendar.routes.materializationPort!.materializeInventory({
          organizationId,
          propertyId,
          configurationSource: configuration.source,
          expectedMaterializedRevision: configuration.calendarRevision,
          horizon,
          idempotencyKey: `materialize-${configuration.calendarRevision}-${suffix}`,
          audit: commandAudit(`materialize-${configuration.calendarRevision}`),
        });
      const saveCalendar = async (
        roomTypeIds: readonly string[],
        expectedCalendarRevision: number,
        horizon: { from: string; through: string },
      ) =>
        prepareCalendar(await saveCalendarRevision(roomTypeIds, expectedCalendarRevision), horizon);
      ok(
        await saveCalendar([gardenSuite], 0, { from: localDate(-1), through: localDate(364) }),
        "first calendar",
      );

      // 9. The next day the hotel adds a room (TEST ONLY: room caa60b1c on 10-10).
      const seaSuite = await addRoom("Sea Suite", "setup-room-b");
      // The saved prices still hold for the Garden Suite; the new room waits for its own (VAY-2129).
      const afterRoomAdded = blockerCodes(await readiness());
      expect(afterRoomAdded).toContain("booking.calendar:operating_calendar_source_stale");
      expect(afterRoomAdded).not.toContain("booking.pricing:pricing_rooms_changed");
      // TEST ONLY on 10-11: the calendar with the added room was saved, but preparing its
      // availability failed, so guests could still book only the first calendar.
      const unprepared = await saveCalendarRevision([gardenSuite, seaSuite], 1);
      // 10-12: the hotel edits its profile and style before it comes back to the calendar. Before
      // VAY-2150 that made the saved calendar stale, so it could never be prepared.
      await presentHotel("present-again", `${SUMMARY} Every suite now has a sea-view terrace.`);
      ok(
        await designRepository.upsertDesign({
          organizationId,
          propertyId,
          actorUserId: owner,
          idempotencyKey: `design-again-${suffix}`,
          expectedRevision: 1,
          choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
          audit: {
            requestId: `design-again-${suffix}`,
            correlationId: `design-again-${suffix}`,
            source: "web",
          },
        }),
        "booking design again",
      );
      expect(unprepared.calendarRevision).toBe(2);
      expect(
        await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId),
      ).toMatchObject({ sourceStatus: "current", configuration: { calendarRevision: 2 } });
      // Saving again previews against the first calendar instead of refusing (VAY-2134). Before
      // VAY-2134 this horizon, starting at today, was also rejected with a 409.
      ok(
        await saveCalendar([gardenSuite, seaSuite], 2, {
          from: localDate(0),
          through: localDate(365),
        }),
        "calendar with the added room",
      );
      await savePrices([gardenSuite, seaSuite], 2);

      // 10. Everything is set up but the billing plan: guests couldn't book yet (VAY-2171).
      const withoutPlan = await readiness();
      expect(blockerCodes(withoutPlan)).toEqual(["booking.payments:billing_plan_not_selected"]);
      expect(withoutPlan).toMatchObject({ outcome: "evaluated", status: "blocked" });
      // "Publish booking page" is refused while the plan is missing.
      await expect(
        runtime.refresh({
          ...scope,
          actorUserId: owner,
          idempotencyKey: `publish-without-plan-${suffix}`,
          audit: {
            requestId: `no-plan-${suffix}`,
            correlationId: `no-plan-${suffix}`,
            source: "web",
          },
        }),
      ).rejects.toThrow("Booking publication readiness is incomplete.");
      // "Your vayada plan" in Payments: the owner confirms Commission through the API route.
      const plans = createFinanceSubscriptionService({
        store: createPgFinanceSubscriptionStore({ connectionString: cs, max: 2 }),
        roomInventory: createTargetPmsRoomInventoryReadPort({ connectionString: cs }),
        pricing: pricingRead,
        returnBaseUrls: { bookingAdmin: "https://admin.booking.example.test" },
      });
      const propertyAccess = createPgPropertyAccessRepository({ connectionString: url!, max: 1 });
      // The owner's session carries every active resource link setup created for the hotel.
      const ownerLinks = (
        await admin.query(
          `SELECT product, resource_type AS "resourceType", resource_id AS "resourceId",
             relationship, status
           FROM identity.organization_resource_links
           WHERE organization_id=$1 AND resource_id=$2 AND status='active'`,
          [organizationId, propertyId],
        )
      ).rows as RequestContext["linkedResources"];
      expect(ownerLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ product: "hotel_catalog", resourceType: "property" }),
          expect.objectContaining({ product: "pms", resourceType: "pms_property" }),
        ]),
      );
      const billingApi = Fastify({ logger: false });
      billingApi.decorateRequest("authContext", null);
      billingApi.addHook("onRequest", async (request) => {
        request.authContext = {
          ...context,
          linkedResources: ownerLinks,
          membership: {
            ...context.membership,
            permissions: [
              "booking.settings.manage",
              "pms.finance.read",
              "pms.operations.manage",
              "finance.billing.manage",
            ],
          },
          audit: requestAudit("plan"),
        } as RequestContext;
      });
      await billingApi.register(registerFinanceSubscriptionRoutes, {
        prefix: "/api",
        service: plans,
        propertyAccessRepository: propertyAccess,
      });
      closers.push(() => billingApi.close());
      closers.push(async () => propertyAccess.close?.());
      const chosen = await billingApi.inject({
        method: "POST",
        url: `/api/finance/properties/${propertyId}/select-commission`,
        payload: { commandId: `plan-${suffix}`, idempotencyKey: `plan-${suffix}` },
      });
      expect(chosen.statusCode, chosen.body).toBe(201);
      expect(chosen.json()).toMatchObject({ planStatus: { plan: "commission" } });
      const planStatus = await billingApi.inject({
        method: "GET",
        url: `/api/finance/properties/${propertyId}/plan-status`,
      });
      expect(planStatus.json()).toMatchObject({
        planStatus: { plan: "commission", status: "commission" },
      });

      // Booking Admin's language setting saves only Booking's list, which the hotel profile
      // doesn't follow; publishing must still work (VAY-2292).
      expect(
        (
          await admin.query(
            "UPDATE booking.booking_settings SET supported_languages = ARRAY['de','en','fr'] WHERE property_id = $1",
            [propertyId],
          )
        ).rowCount,
      ).toBe(1);

      // Ready with no admin action, then "Publish booking page".
      const ready = await readiness();
      expect(blockerCodes(ready)).toEqual([]);
      expect(ready).toMatchObject({ outcome: "evaluated", status: "ready" });
      // VAY-2150: availability prepared today (TEST ONLY prepared it "yesterday") stays ready the
      // next days; launch needs it open at least 11 months ahead, not a full year from today.
      const calendarBlockersInDays = async (days: number) => {
        const evidence = await createPmsBookingPublicationSource({
          rooms: closing(
            createPgPmsRoomPublicationReadModel({
              connectionString: cs,
              roomFacts,
              roomCapacity: roomFacts,
              amenityVocabulary,
              mediaResolver,
            }),
          ),
          pricing: createReplacementPricingPublicationReader(pool),
          pricingCurrency: pricingRead,
          operatingCalendar,
          inventory: calendar.inventory,
          now: () => new Date(Date.now() + days * 86_400_000),
        }).getBookingLaunchEvidence(scope);
        if (evidence.outcome !== "evidence") throw new Error(JSON.stringify(evidence));
        return evidence.entities
          .filter(({ groupId }) => groupId === "booking.calendar")
          .flatMap(({ blockers }) => blockers.map(({ code }) => code));
      };
      expect(await calendarBlockersInDays(1)).toEqual([]);
      expect(await calendarBlockersInDays(31)).toEqual([]);
      expect(await calendarBlockersInDays(32)).toEqual(["inventory_launch_readiness_incomplete"]);
      const requested = await runtime.routes.repository.requestPublication({
        ...scope,
        actorUserId: owner,
        idempotencyKey: `publish-${suffix}`,
        expectedActiveContentRevisionId: null,
        readiness: ready as ReadyBookingPublicationEvidence,
        audit: {
          requestId: `publish-${suffix}`,
          correlationId: `publish-${suffix}`,
          source: "web",
        },
      });
      if (!requested.ok) throw new Error(`publish request: ${requested.error.code}`);
      expect(await runtime.projector.projectPending({ propertyId })).toMatchObject({
        succeeded: 1,
        failed: 0,
      });
      expect(
        await runtime.routes.repository.getPublicationStatus({
          ...scope,
          actorUserId: owner,
          operationId: requested.operation.operationId,
        }),
      ).toMatchObject({ status: "succeeded" });
      const active = (
        await admin.query(
          `SELECT revision.public_content AS content
           FROM distribution.active_public_booking_revision active
           JOIN distribution.public_booking_content_revisions revision
             ON revision.id = active.content_revision_id
           WHERE active.property_id = $1`,
          [propertyId],
        )
      ).rows;
      expect(active).toHaveLength(1);
      expect(
        (active[0]!.content as { rooms: { roomTypeId: string }[] }).rooms
          .map(({ roomTypeId }) => roomTypeId)
          .sort(),
      ).toEqual([gardenSuite, seaSuite].sort());
      const content = active[0]!.content as {
        payments: { readyMethods: string[] };
        profile: {
          hotel: {
            slug: string;
            supportedLocales: string[];
            supportedQuoteParameters: { supportedLocales: string[] };
          };
        };
      };
      expect(content.payments.readyMethods).toEqual([method]);
      // The page offers the owner's Booking languages, not only the profile's (VAY-2292).
      expect(content.profile.hotel.supportedLocales).toEqual(["de", "en", "fr"]);
      expect(content.profile.hotel.supportedQuoteParameters.supportedLocales).toEqual(
        content.profile.hotel.supportedLocales,
      );
      // The public page counts bank transfer and PayPal only while their acceptance is on, and only
      // the ones the booking page takes now.
      const publicProfile = (
        manualPayments: boolean,
        manualMethods: readonly ("bank_transfer" | "paypal")[] = BOTH,
      ) =>
        createActiveBookingPublicationProfileRepository({
          connectionString: cs,
          pool,
          manualPayments,
          manualMethods,
        }).findProfileBySlug(content.profile.hotel.slug);
      expect(await publicProfile(true)).toMatchObject({ hotel: { propertyId } });
      if (manualMethod) expect(await publicProfile(false)).toBeNull();
      else expect(await publicProfile(false)).toMatchObject({ hotel: { propertyId } });
      // VAY-2139: with PayPal's own switch off, a PayPal-only page is hidden; bank transfer stays.
      if (manualMethod === "paypal")
        expect(await publicProfile(true, ["bank_transfer"])).toBeNull();
      else
        expect(await publicProfile(true, ["bank_transfer"])).toMatchObject({
          hotel: { propertyId },
        });
      // VAY-2318: Design Studio saves a hero heading into the booking settings and a colour outside
      // the setup swatches into the booking design, then refreshes the live page, and guests get
      // both. Before, the page kept the hotel name and the setup colour.
      expect(await publicProfile(true)).toMatchObject({
        hotel: { branding: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" } },
      });
      await admin.query(
        `UPDATE booking.booking_settings SET hero_heading = 'Sea-view terraces', updated_at = now()
         WHERE property_id = $1`,
        [propertyId],
      );
      const studioAudit = {
        requestId: `studio-colour-${suffix}`,
        correlationId: `studio-colour-${suffix}`,
        source: "web",
      };
      ok(
        await designRepository.upsertDesign({
          organizationId,
          propertyId,
          actorUserId: owner,
          idempotencyKey: `studio-colour-${suffix}`,
          expectedRevision: 2,
          choices: { primaryColor: "#5E0000", fontPairing: "grand-classic" },
          audit: studioAudit,
        }),
        "Design Studio colour",
      );
      expect(
        await runtime.refresh({
          ...scope,
          actorUserId: owner,
          idempotencyKey: `studio-colour-refresh-${suffix}`,
          audit: studioAudit,
          onlyIfLive: true,
        }),
      ).toMatchObject({ status: "succeeded" });
      expect(await publicProfile(true)).toMatchObject({
        hotel: {
          branding: {
            heroHeading: "Sea-view terraces",
            primaryColor: "#5E0000",
            fontPairing: "grand-classic",
          },
        },
      });
      // A Vayada operator: changes the page address (VAY-2295) and suspends the hotel (step 11).
      await admin.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
        platformAdmin,
        `admin-${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'platform','Vayada',$2,'active')",
        [platformOrganizationId, `platform-${suffix}`],
      );
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,status,role_key,access_origin) VALUES($1,$2,'active','platform_admin','agency')",
        [platformOrganizationId, platformAdmin],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'platform','platform','vayada','operator','active')",
        [platformOrganizationId],
      );
      // The public site in active_publication mode serves the page, its prices, checkout and a
      // quote. The Sea Suite got its first price after the calendar, right before publishing, as
      // TEST ONLY's rooms did on 10-13; production read only legacy profiles then (VAY-2134).
      if (!manualMethod) {
        configureActiveBookingPublicationGate({ servesPublications: true, manualPayments: false });
        closers.push(async () =>
          configureActiveBookingPublicationGate({
            servesPublications: false,
            manualPayments: false,
          }),
        );
        const site = Fastify({ logger: false });
        closers.push(() => site.close());
        const publicRuntime = createPublicRuntimeRepositories(
          {
            publicHotelProfileSource: "active_publication",
            targetDatabaseUrl: cs,
            replacementPricingManualPaymentAcceptanceEnabled: false,
          } as ApiConfig,
          { publicHotelProfilePool: pool },
        );
        await site.register(registerBookingWebPublicRoutes, {
          prefix: "/api/booking-web",
          profileRepository: publicRuntime.publicHotelProfileRepository,
          checkoutAdapter: createTargetBookingWebCheckoutAdapter({
            externalChanges: externalBookingChanges,
            connectionString: cs,
            pool,
            mediaServing: serving,
            inventoryReservationPort: createTargetPmsInventoryReservationPort(),
            replacementPricingAcceptanceEnabled: true,
            replacementPricingRequestAcceptanceEnabled: true,
          }),
        });
        const slug = content.profile.hotel.slug;
        const read = async (path: string) => {
          const response = await site.inject({ method: "GET", url: `/api/booking-web${path}` });
          expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
          return response.json() as unknown;
        };
        await read(`/hosts/${slug}.next-booking.vayada.com`);
        await read(`/hotels/${slug}?locale=en`);
        type Offers = { rooms: { roomTypeId: string; offers: { publicOfferKey: string }[] }[] };
        const offered = (await read(`/hotels/${slug}/pricing-offers`)) as Offers;
        expect(offered.rooms.map(({ roomTypeId }) => roomTypeId).sort()).toEqual(
          [gardenSuite, seaSuite].sort(),
        );
        // The room cards' facts: size, category and amenities as public labels (VAY-2190).
        expect(offered.rooms.find(({ roomTypeId }) => roomTypeId === seaSuite)).toMatchObject({
          size: { value: 28, unit: "sqm" },
          category: "Suite",
          amenities: ["Wi-Fi", "Air conditioning"],
        });
        expect(await read(`/hotels/${slug}/checkout-config`)).toMatchObject({
          termsText: "Our guest terms.",
        });
        const quoteSeaSuite = async (at = slug) => {
          const offers = (await read(`/hotels/${at}/pricing-offers`)) as Offers;
          return site.inject({
            method: "POST",
            url: `/api/booking-web/hotels/${at}/bookings/quote`,
            headers: { "Idempotency-Key": randomUUID() },
            payload: {
              version: "public-booking-quote-request.v1",
              selection: {
                version: "public-pricing-selection.v1",
                checkIn: localDate(30),
                checkOut: localDate(32),
                currency: "EUR",
                rooms: [
                  {
                    selectionId: "sea-suite",
                    publicOfferKey: offers.rooms.find(({ roomTypeId }) => roomTypeId === seaSuite)!
                      .offers[0]!.publicOfferKey,
                    guests: { adults: 2, childAgesAtCheckIn: [] },
                  },
                ],
                addons: [],
                promoCode: null,
              },
              paymentMethod: "pay_at_property",
            },
          });
        };
        // TEST ONLY's prices declare "all mandatory charges included": the quote is the room price
        // with no extra charges, and the guest can book the stay (VAY-2134).
        const quote = await quoteSeaSuite();
        expect(quote.statusCode, quote.body).toBe(200);
        const quoted = quote.json() as {
          quoteId: string;
          totalMinor: string;
          lines: { kind: string; amountMinor: string }[];
        };
        expect(quoted.lines.length).toBeGreaterThan(0);
        expect(quoted.lines.filter(({ kind }) => kind === "charge")).toEqual([]);
        // The room cards' stay prices use the quote's calculation and issue no quote (VAY-2190).
        const quoteRows = async () =>
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM booking.pricing_quotes WHERE property_id=$1",
              [propertyId],
            )
          ).rows[0].n as number;
        const quotesBefore = await quoteRows();
        type StayPrices = {
          rooms: {
            roomTypeId: string;
            roomCount: number;
            availability: string;
            offers: { status: string; totalMinor?: string }[];
          }[];
        };
        const stayPrices = (await read(
          `/hotels/${slug}/pricing-offers/stay-prices?checkIn=${localDate(30)}&checkOut=${localDate(32)}&adults=2`,
        )) as StayPrices;
        const seaPrices = stayPrices.rooms.find(({ roomTypeId }) => roomTypeId === seaSuite)!;
        expect(seaPrices).toMatchObject({ roomCount: 1, availability: "available" });
        expect(seaPrices.offers[0]).toMatchObject({
          status: "priced",
          totalMinor: quoted.totalMinor,
        });
        expect(await quoteRows()).toBe(quotesBefore);
        // The hotel chose Commission in setup Payments before publishing (VAY-2171), which is the
        // billing plan the acceptance terms need. The PMS reservation worker below runs as admin.
        const billingPool = new pg.Pool({ connectionString: url, max: 1 });
        closers.push(() => billingPool.end());
        const acceptQuote = async ({ quoteId }: { quoteId: string }, guest: string) => {
          const disclosure = (await read(
            `/hotels/${slug}/bookings/quotes/${quoteId}/guest-disclosure`,
          )) as { quoteEvidenceId: string; guestPolicyEvidenceId: string };
          const acceptanceKey = randomUUID();
          const accepted = await site.inject({
            method: "POST",
            url: `/api/booking-web/hotels/${slug}/bookings/quotes/${quoteId}/accept`,
            headers: { "Idempotency-Key": acceptanceKey },
            payload: {
              version: "booking-quote-acceptance.v1",
              requestId: acceptanceKey,
              quoteId,
              acceptance: {
                accepted: true,
                quoteEvidenceId: disclosure.quoteEvidenceId,
                guestPolicyEvidenceId: disclosure.guestPolicyEvidenceId,
              },
              guest: {
                firstName: "Walk",
                lastName: "Guest",
                email: `${guest}-${suffix}@example.test`,
                phone: "+94 77 123 4567",
                countryCode: "LK",
                arrivalTime: null,
                specialRequests: null,
              },
            },
          });
          expect(accepted.statusCode, accepted.body).toBe(200);
          expect(accepted.json()).toMatchObject({
            kind: "accepted",
            bookingReference: expect.any(String),
          });
          // The booking queued its PMS reservation: the worker adopts it, which also leaves
          // nothing queued for another suite's worker on the same database.
          const outcomes: string[] = [];
          const workerClient = await billingPool.connect();
          try {
            for (let attempt = 0; attempt < 5 && outcomes.at(-1) !== "empty"; attempt += 1) {
              await workerClient.query("BEGIN");
              try {
                outcomes.push(
                  await processNextPmsAcceptedPricingReservationJob(workerClient, `walk-${suffix}`),
                );
                await workerClient.query("COMMIT");
              } catch (error) {
                await workerClient.query("ROLLBACK");
                throw error;
              }
            }
          } finally {
            workerClient.release();
          }
          expect(outcomes).toContain("adopted");
          expect(outcomes.at(-1)).toBe("empty");
        };
        await acceptQuote(quoted, "guest");

        // VAY-2295: a Vayada operator moves the page to a new address. The new address serves the
        // republished page and its prices; the former one redirects, and still prices and books
        // for tabs left open on it (the steps below keep using it).
        const addressChange = createPropertySlugChangeCommand({
          connectionString: cs,
          refresh: runtime.refresh.bind(runtime),
          readiness: runtime.routes.readinessProvider,
        });
        closers.push(() => addressChange.close());
        const operatorAudit = {
          actorUserId: platformAdmin,
          organizationId: platformOrganizationId,
          requestId: `address-${suffix}`,
          correlationId: `address-${suffix}`,
          requestedAt: now(),
        };
        const moved = `moved-${suffix}`;
        const addressPlan = await addressChange.preview({
          propertyId,
          slug: moved,
          audit: operatorAudit,
        });
        expect(addressPlan.plan).toMatchObject({
          fromSlug: slug,
          toSlug: moved,
          livePage: { pageSlug: slug, republishAsUserId: owner },
        });
        expect(
          await addressChange.apply({
            propertyId,
            slug: moved,
            audit: operatorAudit,
            reason: "Setup walk address change",
            expectedPlanSha256: addressPlan.planSha256,
          }),
        ).toMatchObject({ publication: { status: "succeeded" } });
        // The old host now answers with a permanent redirect to the new page.
        expect(await read(`/hosts/${slug}.next-booking.vayada.com`)).toMatchObject({
          hotel: { slug: moved },
          shouldRedirect: true,
          redirectStatus: 308,
        });
        for (const at of [moved, slug]) {
          expect(await read(`/hotels/${at}?locale=en`)).toMatchObject({ hotel: { slug: moved } });
          const movedQuote = await quoteSeaSuite(at);
          expect(movedQuote.statusCode, movedQuote.body).toBe(200);
        }

        // VAY-2150: hotel and room detail edits after the calendar save keep it current, so the
        // page stays ready and guests can still book. Before, accepting failed with "Quote
        // inventory is unavailable" until the calendar was saved again.
        await presentHotel("present-after-calendar", `${SUMMARY} Breakfast is served until noon.`);
        await advancePublicProfileRevision(pool, propertyId); // a hotel photo finished processing
        const seaSuiteRevisions = async () =>
          (
            await admin.query<{ facts: string; units: string }>(
              `SELECT room_facts_revision AS facts, room_units_revision AS units
               FROM pms.room_types WHERE id=$1`,
              [seaSuite],
            )
          ).rows[0]!;
        ok(
          await rooms.facts.updateRoomTypeFacts(
            parsed(
              parseUpdateRoomTypeFactsCommand({
                organizationId,
                propertyId,
                roomTypeId: seaSuite,
                expectedRevision: Number((await seaSuiteRevisions()).facts),
                facts: { ...roomFacts2("Sea Suite"), description: "Sea Suite with a bathtub." },
                idempotencyKey: `facts-after-calendar-${suffix}`,
                audit: commandAudit("facts-after-calendar"),
              }),
              "room details edit",
            ),
          ),
          "room details edit",
        );
        expect(
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId),
        ).toMatchObject({ sourceStatus: "current", sourceConflicts: [] });
        expect(blockerCodes(await readiness())).toEqual([]);
        const quoteAfterEdits = await quoteSeaSuite();
        expect(quoteAfterEdits.statusCode, quoteAfterEdits.body).toBe(200);
        await acceptQuote(quoteAfterEdits.json() as { quoteId: string }, "guest-after-edits");
        // VAY-2469: what a later room change must keep on the Sea Suite's nights: the two guests'
        // bookings above, a room block made in the PMS and a manual limit of one room.
        const operations = createTargetPmsOperationsCommandRepository({
          connectionString: cs,
          pool,
          readRepository: createTargetPmsOperationsReadRepository({ connectionString: cs, pool }),
        });
        const operationsAudit = (step: string) => ({
          actor: { kind: "user" as const, userId: owner, organizationId },
          requestId: `${step}-${suffix}`,
          reason: step,
          requestedAt: now(),
        });
        const unitsOf = async (roomTypeId: string) =>
          (
            await admin.query<{ id: string }>(
              "SELECT id::text FROM pms.rooms WHERE room_type_id=$1 AND status<>'retired' ORDER BY id",
              [roomTypeId],
            )
          ).rows.map(({ id }) => id);
        expect(
          await operations.createRoomBlocks!({
            propertyId,
            commandId: randomUUID(),
            idempotencyKey: `block-${suffix}`,
            roomTypeId: seaSuite,
            roomIds: [(await unitsOf(seaSuite))[0]!],
            startsOn: localDate(40),
            endsOn: localDate(41),
            reason: "Painting",
            audit: operationsAudit("block"),
          }),
        ).toMatchObject({ ok: true });
        await admin.query(
          `UPDATE pms.inventory_days SET manual_sellable_limit_count=1,
             manual_source_revision=manual_source_revision+1, inventory_revision=inventory_revision+1,
             effective_sellable_limit_count=1, available_count=GREATEST(0,1-assigned_count-blocked_count)
           WHERE room_type_id=$1 AND stay_date=$2::date`,
          [seaSuite, localDate(50)],
        );
        // A changed unit count still changes the calendar.
        ok(
          await rooms.units.reconcilePhysicalRoomUnits(
            parsed(
              parseReconcilePhysicalRoomUnitsCommand({
                organizationId,
                propertyId,
                roomTypeId: seaSuite,
                expectedRevision: Number((await seaSuiteRevisions()).units),
                targetActiveUnitCount: 3,
                idempotencyKey: `units-after-calendar-${suffix}`,
                audit: commandAudit("units-after-calendar"),
              }),
              "room units change",
            ),
          ),
          "room units change",
        );
        expect(
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId),
        ).toMatchObject({
          sourceStatus: "stale",
          sourceConflicts: [{ code: "room_units_revision_conflict", roomTypeId: seaSuite }],
        });
        expect(blockerCodes(await readiness())).toContain(
          "booking.calendar:operating_calendar_source_stale",
        );

        // VAY-2469, as at Tiga Lombok: the owner also duplicates the Sea Suite in the PMS, gives the
        // copy two rooms and prices it. Nothing told the calendar: the copy has no nights, and the
        // Sea Suite still counts two rooms, both booked on the guests' nights.
        const duplicated = await operations.duplicateRoomType({
          propertyId,
          roomTypeId: seaSuite,
          commandId: randomUUID(),
          idempotencyKey: `duplicate-${suffix}`,
          expectedVersion: `room-type-facts-v${Number((await seaSuiteRevisions()).facts)}`,
          audit: operationsAudit("duplicate"),
        });
        if (!duplicated.ok) throw new Error(`duplicate failed: ${JSON.stringify(duplicated)}`);
        const copy = duplicated.roomType.roomTypeId;
        type RoomPorts = {
          reconcile: typeof rooms.units.reconcilePhysicalRoomUnits;
          label: typeof rooms.labels.setPhysicalRoomOperationalLabel;
        };
        // The PMS room form's "Total rooms": reconcile the count, then name each new room.
        const setTotalRooms = async (
          roomTypeId: string,
          targetActiveUnitCount: number,
          step: string,
          port: RoomPorts,
        ) => {
          const expectedRevision = Number(
            (
              await admin.query("SELECT room_units_revision FROM pms.room_types WHERE id=$1", [
                roomTypeId,
              ])
            ).rows[0]!.room_units_revision,
          );
          const reconciled = ok(
            await port.reconcile(
              parsed(
                parseReconcilePhysicalRoomUnitsCommand({
                  organizationId,
                  propertyId,
                  roomTypeId,
                  expectedRevision,
                  targetActiveUnitCount,
                  idempotencyKey: `units-${step}-${suffix}`,
                  audit: commandAudit(`units-${step}`),
                }),
                step,
              ),
            ),
            step,
          );
          let revision = reconciled.response.capacity.roomUnitsRevision;
          for (const [index, unit] of reconciled.response.addedUnits.entries()) {
            revision = ok(
              await port.label(
                parsed(
                  parseSetPhysicalRoomOperationalLabelCommand({
                    organizationId,
                    propertyId,
                    roomTypeId,
                    roomUnitId: unit.roomUnitId,
                    expectedRevision: revision,
                    operationalLabel: `${step.toUpperCase()}-${index + 1}`,
                    idempotencyKey: `label-${step}-${index}-${suffix}`,
                    audit: commandAudit(`label-${step}-${index}`),
                  }),
                  `${step} label`,
                ),
              ),
              `${step} label`,
            ).response.roomUnitsRevision;
          }
        };
        const unfollowed: RoomPorts = {
          reconcile: rooms.units.reconcilePhysicalRoomUnits.bind(rooms.units),
          label: rooms.labels.setPhysicalRoomOperationalLabel.bind(rooms.labels),
        };
        await setTotalRooms(copy, 2, "copy", unfollowed);
        const pricingRevision = Number(
          (
            await admin.query("SELECT revision FROM pms.pricing_v2_heads WHERE property_id=$1", [
              propertyId,
            ])
          ).rows[0]!.revision,
        );
        await savePrices([gardenSuite, seaSuite, copy], pricingRevision + 1);

        type Night = {
          stayDate: string;
          total: number;
          assigned: number;
          blocked: number;
          manual: number | null;
          available: number;
          status: string;
        };
        const nights = async (roomTypeId: string) =>
          (
            await admin.query<Night>(
              `SELECT stay_date::text AS "stayDate", total_count AS total, assigned_count AS assigned,
                 blocked_count AS blocked, manual_sellable_limit_count AS manual,
                 available_count AS available, status
               FROM pms.inventory_days WHERE room_type_id=$1 AND stay_date>=$2::date
               ORDER BY stay_date`,
              [roomTypeId, localDate(0)],
            )
          ).rows;
        const stayAt = async (roomTypeId: string) =>
          (
            (await read(
              `/hotels/${moved}/pricing-offers/stay-prices?checkIn=${localDate(30)}&checkOut=${localDate(32)}&adults=2`,
            )) as StayPrices
          ).rooms.find((room) => room.roomTypeId === roomTypeId);
        // New Booking in the PMS, for one of the copy's rooms at its published price.
        const pmsRead = createTargetPmsOperationsReadRepository({ connectionString: cs, pool });
        const copyRooms = await unitsOf(copy);
        const newBooking = (roomId: string) =>
          calculateManualBookingPreview(
            { propertyId, organizationId },
            {
              contractVersion: "pms-manual-booking.v1",
              stays: [
                {
                  position: 1,
                  roomId,
                  checkIn: localDate(30),
                  checkOut: localDate(32),
                  adults: 2,
                  children: 0,
                  ratePlanId: "standard",
                  pricing: { kind: "rate_plan", manualOverride: null },
                },
              ],
              addOns: [],
            },
            {
              pms: pmsRead,
              publication: createManualBookingPricingPublicationReader(pool),
              booking: {
                listAddonItemsByHotelId: async () =>
                  ({ addonItems: [] }) as unknown as BookingAddonItemsContext,
              },
            },
          );
        expect(await stayAt(seaSuite)).toMatchObject({ availability: "sold_out" });
        expect(await stayAt(copy)).toMatchObject({ availability: "sold_out" });
        expect(await nights(copy)).toEqual([]);
        await expect(newBooking(copyRooms[0]!)).rejects.toMatchObject({
          body: { code: "room_unavailable" },
        });
        const seaBefore = await nights(seaSuite);
        expect(seaBefore.find(({ stayDate }) => stayDate === localDate(30))).toMatchObject({
          total: 2,
          assigned: 2,
          available: 0,
        });

        // VAY-2472, also as at Tiga Lombok: a Design Studio save (a second gallery photo) can't
        // refresh the live page while the calendar is behind. The hotel is told what to fix
        // instead of a server error, and the hourly catch-up finds the page blocked.
        const gallerySave = await runtime
          .refresh({
            ...scope,
            actorUserId: owner,
            idempotencyKey: `studio-gallery-${suffix}`,
            audit: { requestId: `studio-gallery-${suffix}`, source: "web" },
            onlyIfLive: true,
          })
          .catch((error: unknown) => error);
        expect(gallerySave).toBeInstanceOf(BookingPublicationNotReadyError);
        expect((gallerySave as BookingPublicationNotReadyError).blockers).toContainEqual({
          groupId: "booking.calendar",
          code: "operating_calendar_source_stale",
          message: "Your hotel or rooms changed. Review and save your calendar again.",
        });
        const catchUp = (runId: string) =>
          catchUpLiveBookingPages(
            { pool, refresh: runtime.refresh },
            { runId: `${runId}-${suffix}`, limit: 50, propertyIds: [propertyId] },
          );
        const liveContent = async () =>
          (
            await admin.query<{ id: string; content: { rooms: { roomTypeId: string }[] } }>(
              `SELECT active.content_revision_id::text AS id, revision.public_content AS content
               FROM distribution.active_public_booking_revision active
               JOIN distribution.public_booking_content_revisions revision
                 ON revision.id = active.content_revision_id
               WHERE active.property_id = $1`,
              [propertyId],
            )
          ).rows[0]!;
        const behind = await liveContent();
        expect(await catchUp("catch-up-blocked")).toEqual({
          livePages: 1,
          unchanged: 0,
          refreshed: [],
          blocked: [
            {
              propertyId,
              codes: expect.arrayContaining(["booking.calendar:operating_calendar_source_stale"]),
            },
          ],
          noAccess: [],
          failed: [],
        });
        expect((await liveContent()).id).toBe(behind.id);
        expect(behind.content.rooms.map(({ roomTypeId }) => roomTypeId)).not.toContain(copy);

        // The hourly repair finds the hotel and saves its calendar again as the owner, who saved
        // it last: the same schedule and limits, with the copy and the Sea Suite's third room.
        const refreshPorts: PmsOperatingCalendarRoomRefreshPorts = {
          pool,
          calendarRead: operatingCalendar,
          rooms: { roomFacts, roomCapacity: roomFacts },
          preview: calendar.routes.impactPreviewPort,
          calendar: calendar.routes.commandPort,
          materialization: calendar.routes.materializationPort!,
        };
        expect(await findPmsOperatingCalendarRoomRefreshCandidates(pool, 25, [propertyId])).toEqual(
          [{ propertyId, organizationId, userId: owner }],
        );
        expect(
          await repairPmsOperatingCalendarRooms(refreshPorts, {
            limit: 25,
            runId: `repair-${suffix}`,
            propertyIds: [propertyId],
          }),
        ).toEqual({ candidates: 1, refreshed: 1, unchanged: 0, retried: 0, failed: [] });
        expect(await findPmsOperatingCalendarRoomRefreshCandidates(pool, 25, [propertyId])).toEqual(
          [],
        );
        const repaired =
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId);
        expect(repaired).toMatchObject({ sourceStatus: "current", sourceConflicts: [] });
        expect(
          Object.fromEntries(
            repaired!.configuration.sourceInputs.roomBindings.map((binding) => [
              binding.roomTypeId,
              [binding.physicalCapacityCount, binding.startingSellableLimitCount],
            ]),
          ),
        ).toEqual({ [gardenSuite]: [2, 2], [seaSuite]: [3, 3], [copy]: [2, 2] });
        expect(blockerCodes(await readiness())).not.toContain(
          "booking.calendar:operating_calendar_source_stale",
        );
        // VAY-2472: the catch-up after the repair republishes the live page once, as the owner
        // who made it live, so guests get what was saved meanwhile (here: the copy). The next run
        // finds nothing new and leaves the page alone.
        expect(await catchUp("catch-up")).toEqual({
          livePages: 1,
          unchanged: 0,
          refreshed: [propertyId],
          blocked: [],
          noAccess: [],
          failed: [],
        });
        const caughtUp = await liveContent();
        expect(caughtUp.id).not.toBe(behind.id);
        expect(caughtUp.content.rooms.map(({ roomTypeId }) => roomTypeId)).toContain(copy);
        expect(await catchUp("catch-up-again")).toMatchObject({
          livePages: 1,
          unchanged: 1,
          refreshed: [],
        });
        expect((await liveContent()).id).toBe(caughtUp.id);
        // Every Sea Suite night counts three rooms and keeps its bookings, block and manual limit.
        const seaAfter = await nights(seaSuite);
        expect(seaAfter).toEqual(
          seaBefore.map((night) => ({
            ...night,
            total: 3,
            available:
              night.status === "open"
                ? Math.max(0, (night.manual ?? 3) - night.assigned - night.blocked)
                : 0,
          })),
        );
        expect(seaAfter.filter(({ blocked }) => blocked > 0).length).toBeGreaterThan(0);
        expect(seaAfter.find(({ stayDate }) => stayDate === localDate(50))).toMatchObject({
          manual: 1,
          available: 1,
        });
        // The copy has the same nights, both its rooms on sale.
        const copyNights = await nights(copy);
        expect(copyNights.map(({ stayDate }) => stayDate)).toEqual(
          seaAfter.map(({ stayDate }) => stayDate),
        );
        expect(new Set(copyNights.map(({ total, available }) => `${total}/${available}`))).toEqual(
          new Set(["2/2"]),
        );
        // The booking page sells the third Sea Suite and the copy, at their prices; New Booking
        // prices the copy's rooms.
        expect(await stayAt(seaSuite)).toMatchObject({ availability: "available", roomsLeft: 1 });
        expect(await stayAt(copy)).toMatchObject({
          availability: "available",
          roomsLeft: 2,
          offers: [{ status: "priced" }],
        });
        for (const roomId of copyRooms) {
          expect(await newBooking(roomId)).toMatchObject({
            stays: [{ roomId, standardTotal: { currency: "EUR" } }],
          });
        }
        const thirdSeaSuite = await quoteSeaSuite(moved);
        expect(thirdSeaSuite.statusCode, thirdSeaSuite.body).toBe(200);
        await acceptQuote(thirdSeaSuite.json() as { quoteId: string }, "guest-third-room");
        expect(await stayAt(seaSuite)).toMatchObject({ availability: "sold_out" });

        // The owner then closes the hotel for a season, with a two-night minimum. From now on the
        // PMS room commands bring the calendar along themselves: a third room for the copy keeps
        // the season, the minimum stay and the other rooms' limits.
        const season = closedSeason();
        const seasonal = {
          organizationId,
          propertyId,
          expectedCalendarRevision: repaired!.configuration.calendarRevision,
          expectedPropertyProfileRevision: await profileRevision(),
          schedule: { mode: "recurring", periods: season.periods },
          defaultMinimumStayNights: 2,
          roomTypeLimits: repaired!.configuration.sourceInputs.roomBindings.map((binding) => ({
            roomTypeId: binding.roomTypeId,
            expectedRoomFactsRevision: binding.sourceRoomFactsRevision,
            expectedRoomUnitsRevision: binding.sourceRoomUnitsRevision,
            startingSellableLimitCount: binding.startingSellableLimitCount,
          })),
        };
        const seasonalPreview = ok(
          await calendar.routes.impactPreviewPort.previewOperatingCalendarImpact(
            parsed(
              parsePreviewPmsOperatingCalendarImpactCommand({
                ...seasonal,
                audit: commandAudit("calendar-preview-season"),
              }),
              "seasonal calendar preview",
            ),
          ),
          "seasonal calendar preview",
        );
        const seasonalCalendar = ok(
          await calendar.routes.commandPort.upsertOperatingCalendar(
            parsed(
              parseUpsertPmsOperatingCalendarCommand({
                ...seasonal,
                impactConfirmation: seasonalPreview.preview.confirmation,
                idempotencyKey: `calendar-season-${suffix}`,
                audit: commandAudit("calendar-season"),
              }),
              "seasonal calendar save",
            ),
          ),
          "seasonal calendar save",
        ).response.configuration;
        ok(
          await prepareCalendar(seasonalCalendar, { from: localDate(0), through: localDate(365) }),
          "seasonal calendar nights",
        );
        const calendarLog: unknown[] = [];
        const followed: RoomPorts = {
          reconcile: followRoomChangesInCalendar(unfollowed.reconcile, refreshPorts, (fields) =>
            calendarLog.push(fields),
          ),
          label: followRoomChangesInCalendar(unfollowed.label, refreshPorts, (fields) =>
            calendarLog.push(fields),
          ),
        };
        await setTotalRooms(copy, 3, "copy-more", followed);
        expect(calendarLog).toEqual([]);
        const followedCalendar =
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId);
        expect(followedCalendar).toMatchObject({
          sourceStatus: "current",
          configuration: {
            schedule: seasonalCalendar.schedule,
            defaultMinimumStayNights: 2,
          },
        });
        expect(
          Object.fromEntries(
            followedCalendar!.configuration.sourceInputs.roomBindings.map((binding) => [
              binding.roomTypeId,
              [binding.physicalCapacityCount, binding.startingSellableLimitCount],
            ]),
          ),
        ).toEqual({ [gardenSuite]: [2, 2], [seaSuite]: [3, 3], [copy]: [3, 3] });
        // Every room type stays closed for the season, the copy included.
        for (const roomTypeId of [gardenSuite, seaSuite, copy]) {
          expect(
            (await nights(roomTypeId))
              .filter(({ status }) => status === "closed")
              .map(({ stayDate }) => stayDate),
          ).toEqual(season.nights);
        }
        expect(new Set((await nights(copy)).map(({ total }) => total))).toEqual(new Set([3]));
        expect(await stayAt(copy)).toMatchObject({ availability: "available", roomsLeft: 3 });

        // As at one more live hotel in production: setup adds a room type and saves the calendar
        // with it, but its nights are never prepared. The hourly repair prepares them for that
        // saved calendar: the new room type gets the same nights, closed in the season, and every
        // other night keeps its bookings, block, manual limit and season.
        const villa = await addRoom("Hill Villa", "setup-room-c");
        const nightsBefore = Object.fromEntries(
          await Promise.all(
            [gardenSuite, seaSuite, copy].map(async (id) => [id, await nights(id)] as const),
          ),
        );
        const unpreparedRows = (
          await admin.query<{ id: string; facts: string; units: string }>(
            `SELECT id::text, room_facts_revision AS facts, room_units_revision AS units
             FROM pms.room_types WHERE id=ANY($1::uuid[]) ORDER BY id::text`,
            [[gardenSuite, seaSuite, copy, villa]],
          )
        ).rows;
        const limits = new Map(
          followedCalendar!.configuration.sourceInputs.roomBindings.map((binding) => [
            binding.roomTypeId,
            binding.startingSellableLimitCount,
          ]),
        );
        const unpreparedProposal = {
          organizationId,
          propertyId,
          expectedCalendarRevision: followedCalendar!.configuration.calendarRevision,
          expectedPropertyProfileRevision: await profileRevision(),
          schedule: seasonalCalendar.schedule,
          defaultMinimumStayNights: 2,
          roomTypeLimits: unpreparedRows.map((row) => ({
            roomTypeId: row.id,
            expectedRoomFactsRevision: Number(row.facts),
            expectedRoomUnitsRevision: Number(row.units),
            startingSellableLimitCount: limits.get(row.id) ?? 2,
          })),
        };
        const unpreparedPreview = ok(
          await calendar.routes.impactPreviewPort.previewOperatingCalendarImpact(
            parsed(
              parsePreviewPmsOperatingCalendarImpactCommand({
                ...unpreparedProposal,
                audit: commandAudit("calendar-preview-unprepared"),
              }),
              "unprepared calendar preview",
            ),
          ),
          "unprepared calendar preview",
        );
        const savedOnly = ok(
          await calendar.routes.commandPort.upsertOperatingCalendar(
            parsed(
              parseUpsertPmsOperatingCalendarCommand({
                ...unpreparedProposal,
                impactConfirmation: unpreparedPreview.preview.confirmation,
                idempotencyKey: `calendar-unprepared-${suffix}`,
                audit: commandAudit("calendar-unprepared"),
              }),
              "unprepared calendar save",
            ),
          ),
          "unprepared calendar save",
        ).response.configuration;
        expect(
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId),
        ).toMatchObject({ sourceStatus: "current" });
        expect(await nights(villa)).toEqual([]);
        expect(
          await repairPmsOperatingCalendarRooms(refreshPorts, {
            limit: 25,
            runId: `repair-unprepared-${suffix}`,
            propertyIds: [propertyId],
          }),
        ).toEqual({ candidates: 1, refreshed: 1, unchanged: 0, retried: 0, failed: [] });
        expect(
          (
            await admin.query(
              "SELECT calendar_revision AS revision FROM pms.inventory_materialization_coverage WHERE property_id=$1",
              [propertyId],
            )
          ).rows[0]!.revision,
        ).toBe(savedOnly.calendarRevision);
        for (const [id, before] of Object.entries(nightsBefore)) {
          expect(await nights(id)).toEqual(before);
        }
        const villaNights = await nights(villa);
        expect(villaNights.map(({ stayDate }) => stayDate)).toEqual(
          nightsBefore[seaSuite]!.map(({ stayDate }) => stayDate),
        );
        expect(
          villaNights.filter(({ status }) => status === "closed").map(({ stayDate }) => stayDate),
        ).toEqual(season.nights);
        expect(new Set(villaNights.map(({ total }) => total))).toEqual(new Set([2]));
        expect(await findPmsOperatingCalendarRoomRefreshCandidates(pool, 25, [propertyId])).toEqual(
          [],
        );
        // Fewer rooms follow too ...
        await setTotalRooms(copy, 2, "copy-fewer", followed);
        expect(calendarLog).toEqual([]);
        expect(new Set((await nights(copy)).map(({ total }) => total))).toEqual(new Set([2]));
        // ... unless a night holds more than the rooms left: a manual limit of two rooms keeps the
        // calendar where it is, rather than saving one whose nights can't be prepared.
        await admin.query(
          `UPDATE pms.inventory_days SET manual_sellable_limit_count=2,
             manual_source_revision=manual_source_revision+1, inventory_revision=inventory_revision+1,
             effective_sellable_limit_count=2, available_count=GREATEST(0,2-assigned_count-blocked_count)
           WHERE room_type_id=$1 AND stay_date=$2::date`,
          [copy, localDate(60)],
        );
        const beforeRefused =
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId);
        await setTotalRooms(copy, 1, "copy-crowded", followed);
        expect(calendarLog).toEqual([
          expect.objectContaining({
            propertyId,
            outcome: "not_room_change",
            reason: "room_capacity_protected",
          }),
        ]);
        expect(
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId),
        ).toMatchObject({
          sourceStatus: "stale",
          configuration: { calendarRevision: beforeRefused!.configuration.calendarRevision },
        });
        expect(new Set((await nights(copy)).map(({ total }) => total))).toEqual(new Set([2]));
      }
      if (manualMethod) {
        // Once the site serves setup publications, prices follow the page: hidden while bank
        // transfer and PayPal acceptance is off, quotable while it is on (VAY-2134).
        const authority = async () => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            return await lockPublicPricingAuthority(client, content.profile.hotel.slug);
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
        };
        configureActiveBookingPublicationGate({ servesPublications: true, manualPayments: false });
        try {
          expect(await authority()).toBeNull();
          configureActiveBookingPublicationGate({
            servesPublications: true,
            manualPayments: true,
            manualMethods: BOTH,
          });
          expect(await authority()).toMatchObject({ propertyId });
        } finally {
          configureActiveBookingPublicationGate({
            servesPublications: false,
            manualPayments: false,
          });
        }
        // Without its bank details or PayPal email the page is hidden; restored, it comes back
        // without a new publication.
        const [remove, restore] =
          manualMethod === "bank_transfer"
            ? [
                "UPDATE finance.bank_transfer_destinations SET enabled=false WHERE property_id=$1",
                "UPDATE finance.bank_transfer_destinations SET enabled=true WHERE property_id=$1",
              ]
            : [
                "UPDATE finance.payment_settings SET deposit_policy=deposit_policy-'paypalEmail' WHERE property_id=$1",
                `UPDATE finance.payment_settings
                 SET deposit_policy=jsonb_set(deposit_policy,'{paypalEmail}',to_jsonb('pay-' || $2 || '@example.test'))
                 WHERE property_id=$1`,
              ];
        await admin.query(remove, [propertyId]);
        expect(await publicProfile(true)).toBeNull();
        await admin.query(
          restore,
          manualMethod === "bank_transfer" ? [propertyId] : [propertyId, suffix],
        );
        expect(await publicProfile(true)).toMatchObject({ hotel: { propertyId } });
      }
      expect(unavailable).toEqual([]);

      // 11. Vayada can still suspend a hotel: it can't publish or take bookings any more.
      const offers = createReplacementPricingPublicationReader(pool);
      expect(await offers.getCurrentPricingOffers(scope)).not.toBeNull();
      const lifecycle = closing(
        createPgPlatformPropertyLifecycleCommandRepository({ connectionString: cs }),
      );
      await lifecycle.changeStatus({
        propertyId,
        expectedLifecycleRevision: Number(
          (
            await admin.query(
              "SELECT lifecycle_revision FROM hotel_catalog.properties WHERE id=$1",
              [propertyId],
            )
          ).rows[0]!.lifecycle_revision,
        ),
        status: "suspended",
        reason: "Setup walk suspension",
        idempotencyKey: `suspend-${suffix}`,
        audit: {
          actorUserId: platformAdmin,
          organizationId: platformOrganizationId,
          requestId: `suspend-${suffix}`,
          correlationId: `suspend-${suffix}`,
          requestedAt: now(),
        },
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM distribution.active_public_booking_revision WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0]!.n,
      ).toBe(0);
      expect(await offers.getCurrentPricingOffers(scope)).toBeNull();
      expect(await readiness()).toMatchObject({ outcome: "provider_failure" });
      expect(unavailable).toContainEqual(
        expect.objectContaining({ port: "catalog", code: "catalog_property_unavailable" }),
      );
      expect(
        await runtime.routes.repository.requestPublication({
          ...scope,
          actorUserId: owner,
          idempotencyKey: `publish-suspended-${suffix}`,
          expectedActiveContentRevisionId: null,
          readiness: ready as ReadyBookingPublicationEvidence,
          audit: { requestId: `publish-suspended-${suffix}`, source: "web" },
        }),
      ).toMatchObject({ ok: false });
      // A later profile save never reactivates a suspended hotel.
      await advancePublicProfileRevision(pool, propertyId);
      expect(
        (
          await admin.query(
            `SELECT property.lifecycle_status AS status, count(audit.id)::int AS audits
             FROM hotel_catalog.properties property
             LEFT JOIN platform.product_audit_events audit ON audit.property_id = property.id
               AND audit.action = 'hotel_catalog.property.lifecycle.auto_activate'
             WHERE property.id = $1 GROUP BY property.lifecycle_status`,
            [propertyId],
          )
        ).rows,
      ).toEqual([{ status: "suspended", audits: 1 }]);
    } finally {
      for (const close of closers.reverse()) await close().catch(() => undefined);
      // Some owners end their pools in the background; drop the login once they are gone.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const open = await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1",
          [login.login],
        );
        if (open.rows[0]!.n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await login.drop();
      await admin.end();
    }
  });
});

function roomFacts2(name: string): RoomTypeFacts {
  return {
    name,
    description: `${name} with a private terrace and garden views.`,
    category: "suite" as RoomTypeFacts["category"],
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
    beds: [{ type: "queen" as RoomTypeFacts["beds"][number]["type"], quantity: 1 }],
    bedrooms: 1,
    bathrooms: 1,
    bathroomType: "private",
    size: { value: 28, unit: "sqm" },
  };
}

function roomPrice(
  propertyId: string,
  roomTypeId: string,
  revision: number,
  termsRevision: string,
) {
  return {
    version: "pricing.v2",
    propertyId,
    roomTypeId,
    revision,
    currency: "EUR",
    capacity: { total: 2, adults: 2, children: 0 },
    children: {
      adultFromAge: 12,
      bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
    },
    offers: [
      {
        id: "standard",
        termsRevision,
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: {
            base: { mode: "flat", amountMinor: "10000" },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: {
          kind: "own",
          rules: {
            minArrivalNights: 1,
            maxStayNights: null,
            closedToArrival: false,
            closedToDeparture: false,
            stopSell: false,
          },
          seasons: [],
          dates: [],
        },
      },
    ],
  };
}

type Owner = { organizationId: string; propertyId: string; owner: string };

/** An uploaded photo awaiting publication, as the media upload flow leaves it. */
async function insertStagedPhoto(admin: pg.Client, objectId: string, scope: Owner) {
  await insertPhoto(admin, objectId, scope, "private");
}

/** A published photo, as Present your hotel or a room photo upload leaves it. */
async function insertPublicPhoto(admin: pg.Client, objectId: string, scope: Owner) {
  await insertPhoto(admin, objectId, scope, "public");
}

const VARIANT_SIZES = {
  original_safe: { widthPx: 1200, heightPx: 800, sizeBytes: 900 },
  large: { widthPx: 1080, heightPx: 720, sizeBytes: 800 },
  thumbnail: { widthPx: 270, heightPx: 180, sizeBytes: 300 },
  blur_preview: { widthPx: 27, heightPx: 18, sizeBytes: 50 },
} as const;

async function insertPhoto(
  admin: pg.Client,
  objectId: string,
  { organizationId, propertyId, owner }: Owner,
  visibility: "private" | "public",
) {
  const variant = (name: (typeof PROPERTY_MEDIA_PUBLIC_VARIANTS)[number]) => {
    const checksum = createHash("sha256").update(`${objectId}:${name}`).digest("hex");
    const path = `media/${objectId}/${name}/sha256-${checksum}.webp`;
    return {
      name,
      checksum,
      ...VARIANT_SIZES[name],
      storageKey: `${visibility}/${path}`,
      publicUrl: visibility === "public" ? `${serving.cdnBaseUrl}/${path}` : null,
    };
  };
  const original = variant("original_safe");
  await admin.query(
    `INSERT INTO platform.media_objects (
       id, bucket, storage_key, storage_kind, visibility, purpose, owner_organization_id,
       property_id, resource_product, resource_type, resource_id, lifecycle_status, content_type,
       width_px, height_px, size_bytes, checksum_sha256, public_approved, created_by_user_id
     ) VALUES ($1, $2, $3, 'vayada_managed', $4, 'property.gallery_image', $5, $6::uuid,
       'hotel_catalog', 'property', $6::text, $7, 'image/webp', $11, $12, $13, $8, $9, $10)`,
    [
      objectId,
      serving.bucketName,
      original.storageKey,
      visibility,
      organizationId,
      propertyId,
      visibility === "private" ? "staged" : "active",
      original.checksum,
      visibility === "public",
      owner,
      original.widthPx,
      original.heightPx,
      original.sizeBytes,
    ],
  );
  for (const name of PROPERTY_MEDIA_PUBLIC_VARIANTS) {
    const item = variant(name);
    await admin.query(
      `INSERT INTO platform.media_variants (
         media_object_id, variant_name, visibility, storage_key, content_type,
         width_px, height_px, size_bytes, checksum_sha256, public_cdn_url
       ) VALUES ($1, $2, $3, $4, 'image/webp', $7, $8, $9, $5, $6)`,
      [
        objectId,
        name,
        visibility,
        item.storageKey,
        item.checksum,
        item.publicUrl,
        item.widthPx,
        item.heightPx,
        item.sizeBytes,
      ],
    );
  }
}
