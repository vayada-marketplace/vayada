import { createHash, randomUUID } from "node:crypto";

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
import {
  createDedicatedLockConnections,
  createHotelFirstRunRuntime,
} from "./domains/hotelFirstRunRuntime.js";
import type { HotelFirstRunRequest } from "./domains/hotelFirstRunService.js";
import type { HotelFirstRunActor } from "./domains/hotelFirstRunSteps.js";
import { createPgHotelSetupChecklistRepository } from "./domains/hotelSetupChecklistRepository.js";
import { createHotelSetupChecklistService } from "./domains/hotelSetupChecklistService.js";
import { createPgHotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgPmsCalendarAutoOpenSettingsRepository } from "./domains/pmsCalendarAutoOpenSettingsRepository.js";
import { lockPmsInventoryMutationScope } from "./domains/pmsInventoryMutationLock.js";
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
import {
  createOrdinaryHotelSetupActivation,
  createOrdinaryHotelSetupProfileCommand,
} from "./platform/hotelSetupProfileWriter.js";
import type { PlatformMediaServingConfig } from "./platform/mediaServing.js";
import { installPostgresPoolRuntime } from "./platform/postgresRuntime.js";
import {
  advancePublicProfileRevision,
  createPgSharedHotelSetupStatusRepository,
} from "./platform/sharedHotelSetupStatusReadModel.js";
import { createTargetPlatformAdminDashboardRepository } from "./routes/platform/admin/dashboard/bookingCompatible.js";

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
  rooms: [{ name: "Garden Suite", numberOfRooms: 3, maxGuests: 2, pricePerNight: "14500" }],
  pricesIncludeMandatoryCharges: true,
  guestPayment: "pay_at_property",
  plan: "commission",
  freeCancellationDays: 3,
  bed: "double",
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

/** An approved public hotel photo, written straight to the tables (as the 0482 backfill test does). */
async function insertPublicPhoto(client: pg.Client, propertyId: string) {
  const mediaId = randomUUID();
  const checksum = createHash("sha256").update(`${mediaId}:original_safe`).digest("hex");
  const path = `media/${mediaId}/original_safe/sha256-${checksum}.webp`;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO platform.media_objects (
         id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
         resource_product, resource_type, resource_id, lifecycle_status, content_type,
         width_px, height_px, size_bytes, checksum_sha256, public_approved
       ) VALUES ($1, 'vayada-media-test', $2, 'vayada_managed', 'public', 'property.hero_image', $3::uuid,
         'hotel_catalog', 'property', $3::text, 'active', 'image/webp', 1200, 800, 900, $4, TRUE)`,
      [mediaId, `public/${path}`, propertyId, checksum],
    );
    await client.query(
      `INSERT INTO platform.media_variants (
         media_object_id, variant_name, visibility, storage_key, content_type,
         width_px, height_px, size_bytes, checksum_sha256, public_cdn_url
       ) VALUES ($1, 'original_safe', 'public', $2, 'image/webp', 1200, 800, 900, $3, $4)`,
      [mediaId, `public/${path}`, checksum, `https://cdn.example.test/${path}`],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_media
         (property_id, media_type, url, sort_order, source_system, public_approved,
          platform_media_object_id)
       VALUES ($1, 'hero_image', $2, 0, 'platform', TRUE, $3)`,
      [propertyId, `https://cdn.example.test/${path}`, mediaId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
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
        lockPool: createDedicatedLockConnections(cs),
        pricingPool: pool,
        profile: profiles,
        profileCommand: createOrdinaryHotelSetupProfileCommand(pool),
        activateProperty: createOrdinaryHotelSetupActivation(pool),
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
        pool,
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
        // The checklist's light read agrees, without the booking readiness (VAY-2247 incident).
        expect(await h.service().readSetupProgress(h.actor)).toEqual({
          firstRoom: true,
          guestPayment: true,
        });
        // It takes no locks either: it answers while a pricing save holds the owner locks.
        let timer: NodeJS.Timeout | undefined;
        await h.admin.query("BEGIN");
        try {
          await lockPmsInventoryMutationScope(h.admin, h.propertyId);
          await h.admin.query("SELECT 1 FROM identity.organizations WHERE id=$1 FOR UPDATE", [
            h.organizationId,
          ]);
          const late = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("the light read waited on the pricing locks")),
              3_000,
            );
          });
          expect(await Promise.race([h.service().readSetupProgress(h.actor), late])).toEqual({
            firstRoom: true,
            guestPayment: true,
          });
        } finally {
          clearTimeout(timer);
          await h.admin.query("ROLLBACK");
        }

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
        // VAY-2247 wave 1 done: a hotel with only its basics, one room and one price can publish
        // (photos, a description and an amenities review are optional; the first run made it live).
        expect(blockerCodes(await h.readiness())).toEqual([]);
        const property = (
          await h.admin.query(
            `SELECT property.lifecycle_status AS lifecycle, property.profile_status AS profile,
                    slug.slug, count(audit.id)::int AS activations
             FROM hotel_catalog.properties property
             LEFT JOIN hotel_catalog.property_slugs slug ON slug.property_id = property.id
               AND slug.purpose = 'canonical' AND slug.status = 'active'
             LEFT JOIN platform.product_audit_events audit ON audit.property_id = property.id
               AND audit.action = 'hotel_catalog.property.lifecycle.auto_activate'
             WHERE property.id = $1 GROUP BY property.id, slug.slug`,
            [h.propertyId],
          )
        ).rows[0];
        // The address was reserved at creation from the name; the hotel went live once, with an audit row.
        expect(property).toMatchObject({
          lifecycle: "active",
          profile: "complete",
          // The name, or the name and the hotel's id when another test hotel took it first.
          slug: expect.stringMatching(/^first-run-beach-hotel(-[a-z0-9]+)?$/),
          activations: 1,
        });

        // A second run finds everything in place.
        const again = await h.service().run(h.actor, request, h.email);
        expect(again).toMatchObject({ ok: true, ran: [] });
      } finally {
        await h.close();
      }
    });

    it("creates several room types, numbers their rooms on across them and prices each (1.12)", async () => {
      const h = await hotel();
      try {
        const rooms = [
          ...request.rooms,
          { name: "Ocean Villa", numberOfRooms: 2, maxGuests: 4, pricePerNight: "26000" },
        ];
        const result = await h.service().run(h.actor, { ...request, rooms }, h.email);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, checkoutUrl: null });
        if (!result.ok) return;
        expect(new Set(result.state.steps.map((step) => step.state))).toEqual(new Set(["done"]));

        // Room names are unique in a hotel: the villas continue after the suites.
        const { roomFacts } = h.ports;
        const types = await roomFacts.listRoomTypeFacts(h.propertyId);
        const byName = new Map(types.map((type) => [type.facts.name, type]));
        expect([...byName.keys()].sort()).toEqual(["Garden Suite", "Ocean Villa"]);
        expect(byName.get("Ocean Villa")?.facts.occupancy).toEqual({
          maxGuests: 4,
          maxAdults: 4,
          maxChildren: 3,
        });
        const labels = async (name: string) =>
          (
            await roomFacts.listPhysicalRoomUnitIdentities(
              h.propertyId,
              byName.get(name)!.roomTypeId,
            )
          )
            .map((unit) => `${unit.operationalLabel}:${unit.operationalLabelStatus}`)
            .sort();
        expect(await labels("Garden Suite")).toEqual([
          "Room 1:verified",
          "Room 2:verified",
          "Room 3:verified",
        ]);
        expect(await labels("Ocean Villa")).toEqual(["Room 4:verified", "Room 5:verified"]);

        // Both are priced and on the calendar, so nothing blocks publishing; a second run writes nothing.
        expect(blockerCodes(await h.readiness())).toEqual([]);
        expect(await h.service().run(h.actor, { ...request, rooms }, h.email)).toMatchObject({
          ok: true,
          ran: [],
        });
      } finally {
        await h.close();
      }
    });

    it("gives every room type the owner's bed and every price the owner's cancellation (1.12b)", async () => {
      const h = await hotel();
      try {
        const rooms = [
          ...request.rooms,
          { name: "Ocean Villa", numberOfRooms: 2, maxGuests: 4, pricePerNight: "26000" },
        ];
        const chosen = {
          ...request,
          rooms,
          freeCancellationDays: 7 as const,
          bed: "twin" as const,
        };
        const result = await h.service().run(h.actor, chosen, h.email);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });

        const types = await h.ports.roomFacts.listRoomTypeFacts(h.propertyId);
        expect(types.map((type) => [type.facts.name, type.facts.beds]).sort()).toEqual([
          ["Garden Suite", [{ type: "twin", quantity: 2 }]],
          ["Ocean Villa", [{ type: "twin", quantity: 2 }]],
        ]);
        const terms = await h.admin.query<{
          room_type_id: string;
          cancellation: unknown;
          payment: unknown;
        }>(
          `SELECT DISTINCT room_type_id, terms->'cancellation' AS cancellation, terms->'payment' AS payment
             FROM booking.pricing_v2_offer_terms WHERE property_id = $1`,
          [h.propertyId],
        );
        expect(terms.rows).toHaveLength(2);
        for (const row of terms.rows) {
          expect(row.cancellation).toEqual({
            kind: "flexible",
            terms: {
              type: "free_until_days_before_arrival",
              freeCancellationDeadlineDays: 7,
              afterDeadlinePenalty: "full_booking_amount",
              noShowPenalty: "full_booking_amount",
            },
          });
          expect(row.payment).toEqual({ kind: "full", acceptedMethods: ["pay_at_property"] });
        }
        // Still a refundable rate paid at the hotel, so nothing blocks publishing.
        expect(blockerCodes(await h.readiness())).toEqual([]);
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
        expect(await h.service().readSetupProgress(h.actor)).toEqual({
          firstRoom: false,
          guestPayment: false,
        });
        // A first run that stopped leaves the hotel being set up; finishing it makes it live.
        const lifecycle = async () =>
          (
            await h.admin.query(
              "SELECT lifecycle_status AS lifecycle FROM hotel_catalog.properties WHERE id=$1",
              [h.propertyId],
            )
          ).rows[0]?.lifecycle;
        expect(await lifecycle()).toBe("provisioning");
        const resumed = await h.service().run(h.actor, request, h.email);
        expect(resumed).toMatchObject({
          ok: true,
          ran: ["pricing", "calendar", "guest_rules", "plan"],
        });
        expect(await lifecycle()).toBe("active");
      } finally {
        await h.close();
      }
    });

    it("keeps a hotel with only its basics being set up on old-setup saves until it has a description and a photo", async () => {
      const h = await hotel();
      try {
        const state = async () =>
          (
            await h.admin.query(
              `SELECT property.lifecycle_status AS lifecycle, property.profile_status AS profile,
                      count(audit.id)::int AS activations
               FROM hotel_catalog.properties property
               LEFT JOIN platform.product_audit_events audit ON audit.property_id = property.id
                 AND audit.action = 'hotel_catalog.property.lifecycle.auto_activate'
               WHERE property.id = $1 GROUP BY property.id`,
              [h.propertyId],
            )
          ).rows[0];
        const dashboard = createTargetPlatformAdminDashboardRepository({
          connectionString: url!,
          pool: {
            query: (text: string, values?: readonly unknown[]) =>
              h.admin.query(text, values as unknown[]),
            end: async () => undefined,
          } as never,
        });
        const label = async () =>
          (await dashboard.listGrowthProperties({ excludeTestData: false })).find(
            (property) => property.id === h.propertyId,
          )?.status;

        // Its profile is complete, but it isn't live: operators don't count it as live, and the
        // owner is told what makes it live.
        expect(await state()).toEqual({
          lifecycle: "provisioning",
          profile: "complete",
          activations: 0,
        });
        expect(await label()).toBe("demo");
        expect(blockerCodes(await h.readiness())).toContain(
          "booking.hotel_profile:hotel_setup_content_missing",
        );

        // An old-setup save or a finished photo upload doesn't make it live on the basics alone,
        // nor with only a description.
        await advancePublicProfileRevision(h.pool, h.propertyId);
        expect(await state()).toMatchObject({ lifecycle: "provisioning", activations: 0 });
        await h.admin.query(
          `INSERT INTO hotel_catalog.property_profiles (property_id, locale, short_description)
           VALUES ($1, 'en', 'A calm hotel by the lighthouse.')
           ON CONFLICT (property_id, locale) DO UPDATE SET short_description = EXCLUDED.short_description`,
          [h.propertyId],
        );
        await advancePublicProfileRevision(h.pool, h.propertyId);
        expect(await state()).toMatchObject({ lifecycle: "provisioning", activations: 0 });
        expect(await label()).toBe("demo");

        // With a description and an approved photo, the next save makes it live, as before VAY-2247.
        await insertPublicPhoto(h.admin, h.propertyId);
        await advancePublicProfileRevision(h.pool, h.propertyId);
        expect(await state()).toEqual({ lifecycle: "active", profile: "complete", activations: 1 });
        expect(await label()).toBe("live");
      } finally {
        await h.close();
      }
    });

    it("a burst of dashboard loads on production pool sizes finishes without starving the pools (VAY-2247 incident)", async () => {
      // As server.ts does: every pool goes through the API's pool runtime (a shared pool of 8 per
      // connection string; one connection for a pool with connection options).
      const OriginalPool = pg.Pool;
      const runtime = installPostgresPoolRuntime(pg);
      let h: Awaited<ReturnType<typeof hotel>> | undefined;
      try {
        h = await hotel();
        const { actor, pool, readiness } = h;
        expect((await h.service().run(actor, request, h.email)).ok).toBe(true);
        const checklist = createHotelSetupChecklistService({
          firstRun: h.service(),
          ...createPgHotelSetupChecklistRepository(pool),
          onlineCardsOffered: false,
        });
        let peak = runtime.snapshot();
        const sampler = setInterval(() => {
          const now = runtime.snapshot();
          if (now.waitingRequests > peak.waitingRequests || now.stalledPools > peak.stalledPools)
            peak = now;
        }, 10);
        // What one Booking Admin dashboard load fires at once: the checklist, the booking page status
        // (the booking readiness) and the dashboard's other reads on the shared pool.
        const load = () => [
          checklist.read(actor),
          readiness(),
          ...Array.from({ length: 8 }, () => pool.query("SELECT pg_sleep(0.02)")),
        ];
        const started = Date.now();
        // Three at once, as at 10:17:58 (the two apps and a reload): three checklist reads in parallel.
        const results = await Promise.allSettled([...load(), ...load(), ...load()]);
        const tookMs = Date.now() - started;
        clearInterval(sampler);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        );
        expect(failures).toEqual([]);
        expect(tookMs, JSON.stringify(peak)).toBeLessThan(10_000);
        expect(peak.stalledPools, JSON.stringify(peak)).toBe(0);
        // Every checklist came back with the first room and guest payment done: next is going live.
        for (const [index, result] of results.entries())
          if (index % 10 === 0)
            expect(result).toMatchObject({
              status: "fulfilled",
              value: { setup: { next: "go_live" } },
            });
      } finally {
        await h?.close();
        await runtime.close();
        Object.defineProperty(pg, "Pool", {
          configurable: true,
          writable: true,
          value: OriginalPool,
        });
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
