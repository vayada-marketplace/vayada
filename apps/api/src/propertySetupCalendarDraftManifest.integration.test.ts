import { randomUUID } from "node:crypto";

import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  getActivePropertySetupStepIds,
  parseResetPropertySetupDraftRequest,
  parseSavePropertySetupDraftRequest,
  type PropertySetupStepId,
} from "@vayada/domain-hotels";
import {
  parseCreateRoomTypeFactsCommand,
  parseReconcilePhysicalRoomUnitsCommand,
  parseUpdateRoomTypeFactsCommand,
  type RoomTypeFacts,
} from "@vayada/domain-pms";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPgHotelCatalogCurrentOwnerEvidencePorts } from "./domains/hotelCatalogCurrentOwnerEvidence.js";
import {
  createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort,
  lockHotelCatalogOperatingCalendarPropertyProfileEvidence,
} from "./domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgHotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgPmsMandatoryChargeConfirmationReadModel } from "./domains/pmsMandatoryChargeConfirmationReadModel.js";
import { createPgPmsOperatingCalendarReadModel } from "./domains/pmsOperatingCalendarReadModel.js";
import { createPgPmsPhysicalRoomUnitReconcileRepository } from "./domains/pmsPhysicalRoomUnitReconcileRepository.js";
import { createPgPmsPricingReadModel } from "./domains/pmsPricingReadModel.js";
import { createPgPmsRecurringPricingReadModel } from "./domains/pmsRecurringPricingReadModel.js";
import { createPgPmsRoomFactsCommandRepository } from "./domains/pmsRoomFactsCommandRepository.js";
import { createPgPmsRoomFactsReadModel } from "./domains/pmsRoomFactsReadModel.js";
import { createPmsRoomFactsVocabularyValidationPort } from "./domains/pmsRoomFactsVocabulary.js";
import { createPgPropertySetupDraftCommandRepository } from "./domains/propertySetupDraftCommandRepository.js";
import { createPgPropertySetupDraftRepository } from "./domains/propertySetupDraftRepository.js";
import { createPgPropertySetupPmsOwnerRepository } from "./domains/propertySetupPmsOwnerRepository.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { createPropertySetupPmsStateProvider } from "./platform/propertySetupPmsState.js";
import {
  createPropertySetupRouteStateReadPort,
  type PropertySetupOwnerStateProviderPort,
} from "./platform/propertySetupRouteState.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";

const url = process.env["TEST_DATABASE_URL"];
const TRACKS = ["hotel_operations"] as const;

function ok<T extends { ok: boolean }>(result: T, step: string): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`${step} failed: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function parsed<T>(value: T | null, step: string): T {
  if (!value) throw new Error(`${step} command is invalid`);
  return value;
}

/** Keys the setup Calendar step compares; a difference shows "Calendar sources changed". */
function changedKeys(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(after)
    .filter((key) => before[key] !== after[key])
    .sort();
}

/** Owners other than PMS answer with fixed facts; only the calendar is under test. */
function stubProvider(
  organizationId: string,
  propertyId: string,
): PropertySetupOwnerStateProviderPort {
  const provenance = (stepId: PropertySetupStepId) =>
    stepId === "booking_design" || stepId === "guest_experience"
      ? "booking"
      : stepId === "payments"
        ? "finance"
        : "hotel_catalog";
  return {
    async getOwnerState(request) {
      return {
        outcome: "found",
        facts: request.stepIds.map((stepId) => ({
          organizationId,
          propertyId,
          stepId,
          product: provenance(stepId),
          ownerDomain: provenance(stepId),
          state: "not_started" as const,
          sourceRevision: `${stepId}:stub`,
          currentBaseRevisions: Object.fromEntries(
            PROPERTY_SETUP_STEP_DEFINITIONS.find(
              (step) => step.stepId === stepId,
            )!.baseRevisionKeys.map((key) => [
              key,
              // Shared with the real PMS pricing fact of a hotel without prices.
              key === "pms.pricing_settings" ? "pricing:0" : `${key}:stub`,
            ]),
          ),
          blockers: [],
        })),
      };
    },
  };
}

/**
 * VAY-2198: a setup Calendar draft with real edits must only be flagged when what the calendar
 * depends on changes (time zone, operating room set, units; VAY-2150), not on a room
 * description or an address edit that keeps the time zone.
 */
describe.skipIf(!url)("setup Calendar draft manifest (VAY-2198)", { timeout: 120_000 }, () => {
  it("flags a calendar draft only for time zone, room set and unit changes", async () => {
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
    const pool = new pg.Pool({ connectionString: cs, max: 4, connectionTimeoutMillis: 5_000 });
    closers.push(() => pool.end());
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const [organizationId, owner, membershipId] = [randomUUID(), randomUUID(), randomUUID()];
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

    try {
      await admin.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [
        owner,
        `owner-${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'hotel_group','Draft hotels',$2,'active')",
        [organizationId, `draft-${suffix}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_memberships
           (id,organization_id,user_id,status,role_key,access_origin,property_access_mode)
         VALUES($1,$2,$3,'active','hotel_owner','agency','all')`,
        [membershipId, organizationId, owner],
      );

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
      const location = {
        countryCode: "LK",
        city: "Galle",
        streetAddress: "",
        postalCode: "",
        timezone: "Asia/Colombo",
        latitude: null,
        longitude: null,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "hidden" as const,
      };
      const profile = {
        displayName: "Draft Beach Hotel",
        propertyType: "hotel" as const,
        contacts: [],
        location,
      };
      const created = await creation.createPropertyProfile({
        organizationId,
        idempotencyKey: `create-${suffix}`,
        correlationId: `create-${suffix}`,
        profile,
        audit: { actorUserId: owner, requestId: `create-${suffix}`, receivedAt: now() },
      });
      const propertyId = created.propertyId;
      const editLocation = async (changes: Partial<typeof location>) => {
        const current = await creation.getPropertyProfile({ organizationId, propertyId });
        if (!current) throw new Error("profile is unavailable");
        const updated = await creation.updatePropertyProfile({
          organizationId,
          propertyId,
          expectedProfileRevision: current.profileRevision,
          profile: { ...profile, location: { ...location, ...changes } },
        });
        if (!updated) throw new Error("profile update was refused");
      };

      // A room with two units, like the Rooms step leaves it.
      const roomFacts = closing(
        createPgPmsRoomFactsCommandRepository({
          connectionString: cs,
          vocabularyValidator: createPmsRoomFactsVocabularyValidationPort(),
        }),
      );
      const units = closing(
        createPgPmsPhysicalRoomUnitReconcileRepository({ connectionString: cs }),
      );
      const room = ok(
        await roomFacts.createRoomTypeFacts(
          parsed(
            parseCreateRoomTypeFactsCommand({
              organizationId,
              propertyId,
              draftRoomId: "setup-room-a",
              expectedRevision: 0,
              facts: facts("A suite with a private terrace."),
              idempotencyKey: `facts-${suffix}`,
              audit: commandAudit("facts"),
            }),
            "room facts",
          ),
        ),
        "room facts",
      );
      const roomTypeId = room.response.roomType.roomTypeId;
      const reconcile = async (step: string, expectedRevision: number, count: number) =>
        ok(
          await units.reconcilePhysicalRoomUnits(
            parsed(
              parseReconcilePhysicalRoomUnitsCommand({
                organizationId,
                propertyId,
                roomTypeId,
                expectedRevision,
                targetActiveUnitCount: count,
                idempotencyKey: `${step}-${suffix}`,
                audit: commandAudit(step),
              }),
              "room units",
            ),
          ),
          "room units",
        ).response.capacity.roomUnitsRevision;
      const unitsRevision = await reconcile("units", 1, 2);

      // The setup PMS state, composed like server.ts.
      const roomFactsRead = closing(createPgPmsRoomFactsReadModel({ connectionString: cs }));
      const profileEvidence = closing(
        createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
          connectionString: cs,
          readOnly: true,
        }),
      );
      const pricing = closing(createPgPmsPricingReadModel({ connectionString: cs }));
      const timeZonePool = new pg.Pool({ connectionString: cs, max: 2 });
      closers.push(() => timeZonePool.end());
      const pmsState = createPropertySetupPmsStateProvider({
        owner: closing(createPgPropertySetupPmsOwnerRepository({ connectionString: cs })),
        pricing,
        publishedPricing: pricing,
        recurringPricing: closing(createPgPmsRecurringPricingReadModel({ connectionString: cs })),
        mandatoryCharges: closing(
          createPgPmsMandatoryChargeConfirmationReadModel({ connectionString: cs }),
        ),
        operatingCalendar: closing(
          createPgPmsOperatingCalendarReadModel({
            connectionString: cs,
            propertyProfileEvidence: profileEvidence,
            roomEvidence: { roomFacts: roomFactsRead, roomCapacity: roomFactsRead },
          }),
        ),
        calendarRegistry: profileEvidence,
        propertyTimeZone: {
          getPropertyProfileEvidence: (id) =>
            lockHotelCatalogOperatingCalendarPropertyProfileEvidence(timeZonePool, id, true),
        },
        catalogLocation: createPgHotelCatalogCurrentOwnerEvidencePorts({ pool }).location,
      });
      const sessions = createPgPropertySetupDraftRepository({ connectionString: cs });
      closers.push(() => sessions.close());
      const stub = stubProvider(organizationId, propertyId);
      const { trackRevision } = await tracks.getTrackStatus({ organizationId });
      const route = createPropertySetupRouteStateReadPort({
        draftRepository: sessions,
        trackRepository: tracks,
        ownerStateProviders: {
          hotel_catalog: stub,
          booking: stub,
          finance: stub,
          review_lifecycle: stub,
          pms: pmsState,
        },
      });
      /** What the Calendar step compares: today's manifest and the draft's, as the route shows it. */
      const calendarStep = async () => {
        const state = await route.getPropertySetupRouteState({
          organizationId,
          propertyId,
          actorUserId: owner,
          selectedTracks: TRACKS,
          expectedTrackRevision: trackRevision,
          authorizedDraftStepIds: getActivePropertySetupStepIds(TRACKS),
        });
        if (state.outcome !== "found") throw new Error(`setup route: ${state.outcome}`);
        const draft = state.session?.drafts.find(({ stepId }) => stepId === "calendar");
        return {
          sessionId: state.session?.sessionId ?? "",
          sessionRevision: state.session?.revision ?? 0,
          current: state.ownerFacts.find(({ stepId }) => stepId === "calendar")!
            .currentBaseRevisions as Readonly<Record<string, string>>,
          draft: draft
            ? {
                revision: draft.revision,
                payload: draft.payload as Readonly<Record<string, unknown>>,
                baseRevisions: draft.baseRevisions as Readonly<Record<string, string>>,
              }
            : null,
        };
      };
      const currentManifest = async () => (await calendarStep()).current;
      const flagged = async () => {
        const step = await calendarStep();
        return changedKeys(step.draft!.baseRevisions, step.current);
      };
      const drafts = closing(createPgPropertySetupDraftCommandRepository({ connectionString: cs }));
      const saveDraft = async (
        step: string,
        expectedBaseRevisions: Readonly<Record<string, string>>,
      ) => {
        const before = await calendarStep();
        const request = parseSavePropertySetupDraftRequest({
          stepId: "calendar",
          payload: {
            "rate.operating_periods": { mode: "year_round", periods: [] },
            "rate.minimum_stay": 3,
            "rate.initial_availability": { limits: { [roomTypeId]: 1 }, confirmed: false },
          },
          dirtyFields: ["rate.operating_periods", "rate.minimum_stay", "rate.initial_availability"],
          expectedBaseRevisions,
          expectedTrackRevision: trackRevision,
          expectedSessionRevision: before.sessionRevision,
          expectedDraftRevision: before.draft?.revision ?? 0,
        });
        if (!request.ok) throw new Error(`draft request: ${JSON.stringify(request)}`);
        ok(
          await drafts.saveStepDraft({
            organizationId,
            propertyId,
            actorUserId: owner,
            idempotencyKey: `${step}-${suffix}`,
            audit: requestAudit(step),
            request: request.value,
          }),
          "calendar draft",
        );
      };
      const editDescription = async (step: string, expectedRevision: number, text: string) =>
        ok(
          await roomFacts.updateRoomTypeFacts(
            parsed(
              parseUpdateRoomTypeFactsCommand({
                organizationId,
                propertyId,
                roomTypeId,
                expectedRevision,
                facts: facts(text),
                idempotencyKey: `${step}-${suffix}`,
                audit: commandAudit(step),
              }),
              "room description",
            ),
          ),
          "room description",
        );

      // The hotel starts its calendar with real edits and leaves them as a draft.
      await saveDraft("draft", await currentManifest());
      expect((await calendarStep()).draft?.payload["rate.minimum_stay"]).toBe(3);
      expect(await flagged()).toEqual([]);

      // Then it edits a room description and the address (same time zone) elsewhere in setup.
      const before = await currentManifest();
      await editDescription("description", 1, "A suite with a private terrace and garden views.");
      const afterDescription = await flagged();
      await editLocation({ streetAddress: "12 Lighthouse Street" });
      const afterAddress = await flagged();
      // What the calendar uses changes: one more unit, then a new time zone.
      const beforeUnits = await currentManifest();
      await reconcile("units-3", unitsRevision, 3);
      const afterUnits = await currentManifest();
      await editLocation({ streetAddress: "12 Lighthouse Street", timezone: "Asia/Kolkata" });
      const afterTimeZone = await currentManifest();

      expect({
        description: afterDescription,
        address: afterAddress,
        unchanged: changedKeys(before, beforeUnits),
        units: changedKeys(beforeUnits, afterUnits),
        timeZone: changedKeys(afterUnits, afterTimeZone),
      }).toEqual({
        description: [],
        address: [],
        unchanged: [],
        units: ["pms.room_units"],
        timeZone: ["hotel_catalog.time_zone"],
      });

      // A draft saved before VAY-2198 keeps the legacy keys (room facts, full location).
      const legacy = await pmsState.getOwnerState({
        organizationId,
        propertyId,
        actorUserId: owner,
        selectedTracks: TRACKS,
        expectedTrackRevision: trackRevision,
        stepIds: ["rooms", "pricing", "calendar"],
      });
      if (legacy.outcome !== "found") throw new Error(`PMS setup state: ${legacy.outcome}`);
      await saveDraft(
        "legacy-draft",
        legacy.facts.find(({ stepId }) => stepId === "calendar")!.legacyBaseRevisions!,
      );
      // Nothing changed since: shown with today's manifest, so its edits are current.
      const converted = await calendarStep();
      expect(converted.draft?.payload["rate.minimum_stay"]).toBe(3);
      expect(converted.draft?.baseRevisions).toEqual(converted.current);
      // A room edit before it is saved again flags it once, as before VAY-2198.
      await editDescription("legacy-description", 2, "A suite with a terrace.");
      expect(await flagged()).toEqual(["hotel_catalog.time_zone", "pms.room_units"]);
      // The Calendar step can still discard it with the manifest the route showed.
      const shown = await calendarStep();
      const reset = parseResetPropertySetupDraftRequest({
        sessionId: shown.sessionId,
        stepId: "calendar",
        expectedTrackRevision: trackRevision,
        expectedSessionRevision: shown.sessionRevision,
        expectedDraftRevision: shown.draft!.revision,
        expectedBaseRevisions: shown.draft!.baseRevisions,
      });
      if (!reset.ok) throw new Error(`reset request: ${JSON.stringify(reset)}`);
      ok(
        await drafts.resetStepDraft({
          organizationId,
          propertyId,
          actorUserId: owner,
          idempotencyKey: `legacy-reset-${suffix}`,
          audit: requestAudit("legacy-reset"),
          request: reset.value,
        }),
        "legacy draft reset",
      );
      expect((await calendarStep()).draft).toBeNull();
    } finally {
      for (const close of closers.reverse()) await close().catch(() => undefined);
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

function facts(description: string): RoomTypeFacts {
  return {
    name: "Garden Suite",
    description,
    category: "suite" as RoomTypeFacts["category"],
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
    beds: [{ type: "queen" as RoomTypeFacts["beds"][number]["type"], quantity: 1 }],
    bedrooms: 1,
    bathrooms: 1,
    bathroomType: "private",
    size: { value: 28, unit: "sqm" },
  };
}
