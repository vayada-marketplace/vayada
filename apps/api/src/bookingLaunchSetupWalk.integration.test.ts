import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
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
  parseUpsertPmsOperatingCalendarCommand,
  parseUpsertPropertyPricingCurrencyCommand,
  type RoomTypeFacts,
} from "@vayada/domain-pms";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPgBookingDesignCatalogEvidenceRepository } from "./domains/bookingDesignCatalogEvidenceRepository.js";
import { createPgBookingDesignRepository } from "./domains/bookingDesignRepository.js";
import { createBookingGuestChoicePublicationReader } from "./domains/bookingGuestChoicePublication.js";
import { createBookingGuestChoiceStore } from "./domains/bookingGuestChoiceStore.js";
import { createPgBookingGuestPolicyScopeAuthorizationPort } from "./domains/bookingGuestPolicyScopeAuthorization.js";
import { createBookingPublicationProductionRuntime } from "./domains/bookingPublicationProductionRuntime.js";
import { createPgFinancePaymentReadinessCommandRepository } from "./domains/financePaymentReadinessCommandRepository.js";
import { createPgFinancePaymentReadinessReadModel } from "./domains/financePaymentReadinessReadModel.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgHotelCatalogStep1Repository } from "./domains/hotelCatalogStep1Repository.js";
import { createPgHotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgPlatformPropertyLifecycleCommandRepository } from "./domains/platformPropertyLifecycleCommandRepository.js";
import { createPgPmsOperatingCalendarReadModel } from "./domains/pmsOperatingCalendarReadModel.js";
import { createPmsOperatingCalendarProductionRuntime } from "./domains/pmsOperatingCalendarProductionRuntime.js";
import { createPgPmsPhysicalRoomOperationalLabelRepository } from "./domains/pmsPhysicalRoomOperationalLabelRepository.js";
import { createPgPmsPhysicalRoomUnitReconcileRepository } from "./domains/pmsPhysicalRoomUnitReconcileRepository.js";
import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD } from "./domains/pmsPricingCurrencyCapabilities.js";
import { createPgPmsPricingReadModel } from "./domains/pmsPricingReadModel.js";
import { createPmsRoomAmenityVocabularyValidationPort } from "./domains/pmsRoomAmenityVocabulary.js";
import { createPgPmsRoomFactsCommandRepository } from "./domains/pmsRoomFactsCommandRepository.js";
import { createPgPmsRoomFactsReadModel } from "./domains/pmsRoomFactsReadModel.js";
import { createPmsRoomFactsVocabularyValidationPort } from "./domains/pmsRoomFactsVocabulary.js";
import { createPgPmsRoomPublicationCommandRepository } from "./domains/pmsRoomPublicationCommandRepository.js";
import { createPgPmsRoomPublicationReadModel } from "./domains/pmsRoomPublicationReadModel.js";
import { createPgS3PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";
import { createReplacementPricingCommands } from "./domains/replacementPricingCommands.js";
import { createReplacementPricingPublicationReader } from "./domains/replacementPricingPublicationReader.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { createPgHotelMediaResolutionPort } from "./platform/hotelMediaResolver.js";
import type { PlatformMediaServingConfig } from "./platform/mediaServing.js";
import {
  advancePublicProfileRevision,
  createPgSharedHotelSetupStatusRepository,
} from "./platform/sharedHotelSetupStatusReadModel.js";
import { syncPropertyOfferReadModels } from "./routes/marketplaceAdmin.js";
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
 */
describe.skipIf(!url)("new hotel setup to a published booking page (VAY-2134)", () => {
  it("walks setup to ready and publishes the booking page", async () => {
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
          contacts: [],
          location: {
            countryCode: "LK",
            city: "Galle",
            streetAddress: "",
            postalCode: "",
            timezone: TIME_ZONE,
            latitude: null,
            longitude: null,
            localityPublic: true,
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
          "booking.hotel_profile:hotel_profile_incomplete",
          "booking.page_style:booking_design_missing",
          "booking.payments:payment_methods_not_configured",
          "booking.pricing:pricing_not_published",
          "booking.rooms:publishable_room_required",
        ]),
      );

      // 2. Present your hotel: summary plus an uploaded cover photo (Step 1 route flow).
      const coverId = randomUUID();
      await insertStagedPhoto(admin, coverId, { organizationId, propertyId, owner });
      const step1 = closing(createPgHotelCatalogStep1Repository({ connectionString: cs }));
      const media = closing(
        createPgS3PropertyMediaCommandRepository({
          connectionString: cs,
          serving,
          syncReadModels: syncPropertyOfferReadModels,
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
          payload: { paymentsEnabled: true, acceptedMethods: ["pay_at_property", "cash"] },
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
                  cancellation: { kind: "non_refundable" },
                  payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
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
      // 10-12: the hotel edits its profile and style before it comes back to the calendar. The
      // saved calendar pins the old profile revision, so it can never be prepared now.
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
      expect(
        await prepareCalendar(unprepared, { from: localDate(0), through: localDate(365) }),
      ).toMatchObject({ ok: false, error: { code: "configuration_not_current" } });
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

      // 10. Ready with no admin action, then "Publish booking page".
      const ready = await readiness();
      expect(blockerCodes(ready)).toEqual([]);
      expect(ready).toMatchObject({ outcome: "evaluated", status: "ready" });
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
      expect(unavailable).toEqual([]);

      // 11. Vayada can still suspend a hotel: it can't publish or take bookings any more.
      const offers = createReplacementPricingPublicationReader(pool);
      expect(await offers.getCurrentPricingOffers(scope)).not.toBeNull();
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
  }, 300_000);
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
