import { randomUUID } from "node:crypto";

import type { RequestContext } from "@vayada/backend-auth";
import {
  FIRST_RUN_GUEST_TERMS,
  createBookingDesignReadinessProvider,
} from "@vayada/domain-booking";
import {
  createHotelMediaResolutionPort,
  type ProductReadinessResult,
  type ReadinessProviderFailure,
} from "@vayada/domain-hotels";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPgBookingDesignCatalogEvidenceRepository } from "./domains/bookingDesignCatalogEvidenceRepository.js";
import { createPgBookingDesignRepository } from "./domains/bookingDesignRepository.js";
import { createBookingGuestChoicePublicationReader } from "./domains/bookingGuestChoicePublication.js";
import { createBookingGuestChoiceStore } from "./domains/bookingGuestChoiceStore.js";
import { createBookingGuestTermsStore } from "./domains/bookingGuestTermsStore.js";
import { createPgBookingGuestPolicyScopeAuthorizationPort } from "./domains/bookingGuestPolicyScopeAuthorization.js";
import { createBookingPublicationProductionRuntime } from "./domains/bookingPublicationProductionRuntime.js";
import { createPgFinancePaymentReadinessCommandRepository } from "./domains/financePaymentReadinessCommandRepository.js";
import { createPgFinancePaymentReadinessReadModel } from "./domains/financePaymentReadinessReadModel.js";
import { createFinanceSubscriptionService } from "./domains/financeSubscriptionService.js";
import { createPgFinanceSubscriptionStore } from "./domains/financeSubscriptionStore.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createHotelFirstRunRuntime } from "./domains/hotelFirstRunRuntime.js";
import type { HotelFirstRunRequest } from "./domains/hotelFirstRunService.js";
import type { HotelFirstRunActor } from "./domains/hotelFirstRunSteps.js";
import { createPgHotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgPmsCalendarAutoOpenSettingsRepository } from "./domains/pmsCalendarAutoOpenSettingsRepository.js";
import { createPgPmsOperatingCalendarReadModel } from "./domains/pmsOperatingCalendarReadModel.js";
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
import { createPgPmsRoomPublicationReadModel } from "./domains/pmsRoomPublicationReadModel.js";
import { createReplacementPricingPublicationReader } from "./domains/replacementPricingPublicationReader.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { createPgHotelMediaResolutionPort } from "./platform/hotelMediaResolver.js";
import { createOrdinaryHotelSetupProfileCommand } from "./platform/hotelSetupProfileWriter.js";
import type { PlatformMediaServingConfig } from "./platform/mediaServing.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";

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
const request: HotelFirstRunRequest = {
  room: { name: "Garden Suite", numberOfRooms: 3, maxGuests: 2, pricePerNight: "14500" },
  pricesIncludeMandatoryCharges: true,
  guestPayment: "pay_at_property",
  plan: "commission",
};

function blockerCodes(readiness: ProductReadinessResult | ReadinessProviderFailure): string[] {
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

/**
 * VAY-2247 wave 1: a brand-new self-serve hotel, created in Sri Lanka with only its basics, goes through the
 * server's first run with the real owner commands on the production-shaped API login. Every default lands as
 * real data, a second run writes nothing, a run without the taxes tick stops before pricing and resumes, and
 * two runs at once for the same hotel are refused. Calendar auto-open (on by default) has no setup error,
 * because every room has a confirmed name (1.10). What still blocks publishing is exactly what the later
 * wave 1 PRs (1.3/1.4/1.5) relax: photos, amenities review, the hotel description and activation.
 */
describe.skipIf(!url)(
  "hotel first run on the real database (VAY-2247)",
  { timeout: 300_000 },
  () => {
    async function hotel() {
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
      const pool = new pg.Pool({ connectionString: cs, max: 8 });
      closers.push(() => pool.end());
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const [organizationId, owner, membershipId] = [randomUUID(), randomUUID(), randomUUID()];
      const now = () => new Date().toISOString();

      await admin.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
        owner,
        `owner-${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'hotel_group','First run hotels',$2,'active')",
        [organizationId, `first-run-${suffix}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_memberships
         (id,organization_id,user_id,status,role_key,access_origin,property_access_mode)
       VALUES($1,$2,$3,'active','hotel_owner','agency','all')`,
        [membershipId, organizationId, owner],
      );
      await closing(
        createPgHotelSetupTrackCommandRepository({ connectionString: cs }),
      ).updateTracks({
        organizationId,
        actorUserId: owner,
        idempotencyKey: `tracks-${suffix}`,
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        audit: {
          requestId: `tracks-${suffix}`,
          correlationId: `tracks-${suffix}`,
          source: "web",
          receivedAt: now(),
        },
      });
      const profiles = createPgSharedHotelSetupStatusRepository({
        connectionString: cs,
        pool,
        hotelSetupOwnerCreation: true,
      });
      // "Your hotel": basics only, the city hidden, no photo, no description.
      const created = await profiles.createPropertyProfile({
        organizationId,
        idempotencyKey: `create-${suffix}`,
        correlationId: `create-${suffix}`,
        profile: {
          displayName: "First Run Beach Hotel",
          propertyType: "hotel",
          contacts: [
            {
              channelType: "email",
              value: "reception@first-run.example.test",
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

      // The API's runtimes, composed like server.ts.
      const mediaAdapter = createPgHotelMediaResolutionPort({ connectionString: cs, serving });
      closers.push(async () => mediaAdapter.close?.());
      const mediaResolver = createHotelMediaResolutionPort(mediaAdapter);
      const roomFacts = closing(createPgPmsRoomFactsReadModel({ connectionString: cs }));
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
        confirmationSecret: "vay2247-first-run-confirmation-secret",
        authorizationPool: pool,
        propertyProfileEvidence: profileEvidence,
        roomEvidence: { roomFacts, roomCapacity: roomFacts },
        operatingCalendar,
      });
      if (!calendar?.routes.materializationPort) throw new Error("Calendar runtime is disabled");
      closers.push(() => calendar.close());
      const financeRead = closing(
        createPgFinancePaymentReadinessReadModel({
          connectionString: cs,
          pricingReadPort: pricingRead,
        }),
      );
      const publication = createBookingPublicationProductionRuntime({
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
            amenityVocabulary: createPmsRoomAmenityVocabularyValidationPort(),
            mediaResolver,
          }),
        ),
        pricing: createReplacementPricingPublicationReader(pool),
        pricingCurrency: pricingRead,
        operatingCalendar,
        inventory: calendar.inventory,
        finance: financeRead,
        financeScope: financeRead,
        warn: () => undefined,
      });
      closers.push(() => publication.close());
      closers.push(async () => publication.routes.repository.close?.());
      const paymentCommands = closing(
        createPgFinancePaymentReadinessCommandRepository({
          connectionString: cs,
          max: 2,
          pricingReadPort: pricingRead,
        }),
      );
      const termsStore = createBookingGuestTermsStore(pool, (client) =>
        createPgBookingGuestPolicyScopeAuthorizationPort({ pool: client }),
      );
      const createService = createHotelFirstRunRuntime({
        lockPool: pool,
        pricingPool: pool,
        profile: profiles,
        profileCommand: createOrdinaryHotelSetupProfileCommand(pool),
        launchSettings: { readDefaultLanguage: async () => "en" },
        pricingRead,
        currency: closing(
          createPgPmsPricingCommandRepository({
            connectionString: cs,
            pool,
            hotelSetupOrdinaryOwner: true,
            currencyChangeGuard: PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD,
          }),
        ),
        roomRead: roomFacts,
        roomFacts: closing(
          createPgPmsRoomFactsCommandRepository({
            connectionString: cs,
            vocabularyValidator: createPmsRoomFactsVocabularyValidationPort(),
          }),
        ),
        units: closing(createPgPmsPhysicalRoomUnitReconcileRepository({ connectionString: cs })),
        labels: closing(
          createPgPmsPhysicalRoomOperationalLabelRepository({ connectionString: cs }),
        ),
        paymentRead: financeRead,
        payments: {
          replacePaymentMethods: (command) =>
            paymentCommands.replacePaymentMethods({ command, currentPricing: null }),
        },
        calendarRead: operatingCalendar,
        preview: calendar.routes.impactPreviewPort,
        calendar: calendar.routes.commandPort,
        materialization: calendar.routes.materializationPort,
        guestRules: createBookingGuestChoiceStore(pool, (client) =>
          createPgBookingGuestPolicyScopeAuthorizationPort({ pool: client }),
        ),
        terms: {
          read: (scope) => termsStore.read(scope),
          save: async (scope, text, expected) => ({
            termsText: (await termsStore.save(scope, text, expected)).termsText ?? "",
          }),
        },
        designRead: designRepository,
        design: designRepository,
        plans: createFinanceSubscriptionService({
          store: createPgFinanceSubscriptionStore({ connectionString: cs, max: 2 }),
          roomInventory: createTargetPmsRoomInventoryReadPort({ connectionString: cs }),
          pricing: pricingRead,
          returnBaseUrls: { bookingAdmin: "https://admin.booking.example.test" },
        }),
        readiness: publication.routes.readinessProvider,
      });

      // The owner's signed-in session, carrying every resource link setup created for the hotel.
      const ownerLinks = (
        await admin.query(
          `SELECT product, resource_type AS "resourceType", resource_id AS "resourceId", relationship, status
         FROM identity.organization_resource_links
         WHERE organization_id=$1 AND resource_id=$2 AND status='active'`,
          [organizationId, propertyId],
        )
      ).rows as RequestContext["linkedResources"];
      const context = {
        actor: {
          internalUserId: owner,
          email: `owner-${suffix}@example.test`,
          status: "active",
          providerIdentity: {
            provider: "workos",
            providerUserId: `user-${suffix}`,
            sessionId: `session-${suffix}`,
          },
        },
        selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
        membership: {
          membershipId,
          roleKey: "hotel_owner",
          status: "active",
          permissions: [
            "hotel_catalog.setup.manage",
            "pms.rooms_rates.read",
            "pms.rooms_rates.manage",
            "pms.operations.manage",
            "pms.finance.read",
            "booking.settings.manage",
          ],
          workosRoleSlugs: [],
        },
        linkedResources: ownerLinks,
        entitlements: [{ product: "pms", key: "property-management", status: "active" }],
        locale: "en",
        currency: "EUR",
        audit: {
          requestId: `first-run-${suffix}`,
          correlationId: `first-run-${suffix}`,
          source: "web",
          receivedAt: now(),
        },
      } as unknown as RequestContext;
      const actor: HotelFirstRunActor = {
        organizationId,
        propertyId,
        userId: owner,
        requestId: `first-run-${suffix}`,
        correlationId: `first-run-${suffix}`,
        requestedAt: now(),
      };
      const close = async () => {
        for (const closer of closers.reverse()) await closer().catch(() => undefined);
        await admin.end();
      };
      return {
        admin,
        propertyId,
        organizationId,
        actor,
        service: () => createService(context),
        ports: {
          pricingRead,
          roomFacts,
          financeRead,
          termsStore,
          profiles,
          designRepository,
          operatingCalendar,
        },
        email: `owner-${suffix}@example.test`,
        readiness: () =>
          publication.routes.readinessProvider.getBookingReadiness({ organizationId, propertyId }),
        close,
      };
    }

    it("saves every default a new hotel needs, then a second run writes nothing", async () => {
      const h = await hotel();
      try {
        const result = await h.service().run(h.actor, request, h.email);
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: true,
          ran: ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"],
          checkoutUrl: null,
        });
        if (!result.ok) return;
        expect(result.state.nextStep).toBeNull();
        expect(new Set(result.state.steps.map((step) => step.state))).toEqual(new Set(["done"]));

        // Sri Lanka → LKR; rooms named Room 1–3; pay at the hotel; the default terms; Grand Classic; the city shown.
        const scope = { organizationId: h.organizationId, propertyId: h.propertyId };
        const {
          pricingRead,
          roomFacts,
          financeRead,
          termsStore,
          profiles,
          designRepository,
          operatingCalendar,
        } = h.ports;
        expect(await pricingRead.getPropertyPricingCurrency(h.propertyId)).toMatchObject({
          currency: "LKR",
        });
        const [room] = await roomFacts.listRoomTypeFacts(h.propertyId);
        expect(room?.facts.occupancy).toEqual({ maxGuests: 2, maxAdults: 2, maxChildren: 1 });
        const units = await roomFacts.listPhysicalRoomUnitIdentities(
          h.propertyId,
          room!.roomTypeId,
        );
        expect(
          units.map((unit) => `${unit.operationalLabel}:${unit.operationalLabelStatus}`).sort(),
        ).toEqual(["Room 1:verified", "Room 2:verified", "Room 3:verified"]);
        const payments = await financeRead.getPaymentReadiness(scope);
        expect(
          payments?.methods.filter((method) => method.selected).map((method) => method.method),
        ).toEqual(["pay_at_property"]);
        expect(
          await operatingCalendar.getCurrentOperatingCalendarConfiguration(h.propertyId),
        ).toBeTruthy();
        expect((await termsStore.read({ ...scope, actorUserId: h.actor.userId })).termsText).toBe(
          FIRST_RUN_GUEST_TERMS,
        );
        expect(JSON.stringify(await designRepository.getCurrentDesign(scope))).toContain(
          "grand-classic",
        );
        expect((await profiles.getPropertyProfile(scope))?.profile.location.localityPublic).toBe(
          true,
        );
        // Auto-open is on by default (VAY-2066) but waits until every room has a confirmed name:
        // the auto-named rooms let it keep the calendar open 12 months ahead from the first day.
        const autoOpen = createPgPmsCalendarAutoOpenSettingsRepository({ connectionString: url! });
        try {
          expect(await autoOpen.findContext(h.propertyId)).toMatchObject({
            setting: { revision: 0, enabled: true, mode: "rolling", rollingMonths: 12 },
            setupError: null,
          });
        } finally {
          await autoOpen.close();
        }

        // Nothing the first run owns still blocks publishing; what's left is exactly what the held
        // wave 1 PRs relax, and each of them shortens this list.
        expect(blockerCodes(await h.readiness())).toEqual([
          "booking.hotel_profile:hotel_setup_in_progress", // 1.5: activate at the end of the first run
          "booking.pricing:pricing_hotel_setup_in_progress", // 1.5: activate at the end of the first run
        ]);

        // A second run finds everything in place.
        const again = await h.service().run(h.actor, request, h.email);
        expect(again).toMatchObject({ ok: true, ran: [] });
      } finally {
        await h.close();
      }
    });

    it("stops before pricing without the taxes tick and resumes there with it", async () => {
      const h = await hotel();
      try {
        const stopped = await h
          .service()
          .run(h.actor, { ...request, pricesIncludeMandatoryCharges: false }, h.email);
        expect(stopped).toMatchObject({
          ok: false,
          code: "mandatory_charges_declaration_required",
          step: "pricing",
          ran: ["currency", "rooms", "payments"],
        });
        expect((await h.service().read(h.actor)).nextStep).toBe("pricing");
        const resumed = await h.service().run(h.actor, request, h.email);
        expect(resumed).toMatchObject({
          ok: true,
          ran: ["pricing", "calendar", "guest_rules", "plan"],
        });
      } finally {
        await h.close();
      }
    });

    it("refuses a second run for the same hotel while one is running", async () => {
      const h = await hotel();
      try {
        const [first, second] = await Promise.all([
          h.service().run(h.actor, request, h.email),
          h.service().run(h.actor, request, h.email),
        ]);
        const codes = [first, second].map((result) => (result.ok ? "ok" : result.code)).sort();
        expect(codes).toEqual(["first_run_in_progress", "ok"]);
      } finally {
        await h.close();
      }
    });
  },
);
