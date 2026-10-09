import {
  roomList,
  pricingSnapshot,
  recurringPricing,
  propertyProfile,
  canonicalTimeZone,
  currentCalendar,
} from "../support/adaptiveSetupOwnerReads";
import {
  createAdaptiveHotelSetupStatusMock,
  mockHotelSetupPrerequisites,
} from "../support/sharedHotelSetupMocks";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import type {
  PropertySetupRouteReadModel,
  PropertySetupStepDraft,
  PropertySetupStepId,
} from "@vayada/domain-hotels";
import {
  PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
  PMS_PRICING_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
} from "@vayada/domain-pms";

import { watchPageHealth } from "../support/pageHealth";
import { createPropertySetupRouteMock } from "../support/propertySetupRouteMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const roomTypeId = "33333333-3333-4333-8333-333333333333";
const acceptedAt = new Date().toISOString();
const confirmationIssuedAt = new Date(Date.now() - 60_000).toISOString();
const confirmationExpiresAt = new Date(
  new Date(confirmationIssuedAt).getTime() + 900_000,
).toISOString();

test.describe("adaptive pricing and calendar", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test("completes desktop pricing and confirmed calendar writes through exact owner boundaries", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const api = await mockPricingCalendarApis(page);
    // Before the first publication the pricing-v2 read answers 404 not_found.
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: [new RegExp(`/properties/${propertyId}/pricing-v2$`)],
    });

    await page.goto(setupUrl(baseURL, "pricing"));
    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("All prices are in EUR.")).toBeVisible();
    await expect(page.getByText("Needs a rate")).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({
      path: testInfo.outputPath("pricing-1-first-rate.png"),
      fullPage: true,
    });

    await page.getByRole("combobox", { name: "Room type" }).selectOption(roomTypeId);
    await page.getByRole("combobox", { name: "How is the room priced?" }).selectOption("flat");
    await page.getByRole("textbox", { name: "Room price per night" }).fill("175.50");
    await page.getByRole("textbox", { name: "Adult pricing starts at age (1–18)" }).fill("12");
    await page.getByRole("textbox", { name: "Price per child per night (0 is allowed)" }).fill("0");
    await page
      .getByRole("combobox", { name: "Children count toward room capacity" })
      .selectOption("yes");
    await page.getByRole("textbox", { name: "Minimum stay in nights" }).fill("1");
    await page.getByRole("combobox", { name: "Cancellation policy" }).selectOption("flexible");
    await page
      .getByRole("textbox", { name: "Free cancellation until days before arrival (0–365)" })
      .fill("7");
    await page.getByRole("combobox", { name: "Payment policy" }).selectOption("full");
    await page.getByRole("checkbox", { name: "Pay at property" }).check();
    await page.getByRole("button", { name: "Add this rate" }).click();

    await expect(page.getByText("Ready to publish")).toBeVisible();
    // Publishing is the mandatory-charges declaration (VAY-2079): no checkbox, one line.
    await expect(page.getByRole("checkbox", { name: /final prices/ })).toHaveCount(0);
    const publish = page.getByRole("button", { name: "Publish prices and continue" });
    await expect(publish).toHaveAccessibleDescription(
      "By publishing, you confirm these prices include all mandatory taxes and fees.",
    );
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath("pricing-2-ready.png"), fullPage: true });
    await publish.click();

    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("pricing-3-published.png"), fullPage: true });
    expect(api.pricingDrafts).toEqual([]);
    expect(api.pricingV2Writes.map(({ request }) => request)).toEqual([
      `PUT /drafts/:id/rooms/${roomTypeId}/offers/:offer/terms`,
      "POST /prepare",
      "PUT /drafts/:id",
      "POST /charges",
      "PUT /drafts/:id",
      "POST /publish",
    ]);
    expect(api.pricingV2Writes[0]!.body).toMatchObject({
      baseRevision: 0,
      expectedRevision: null,
      cancellation: { kind: "flexible", terms: { freeCancellationDeadlineDays: 7 } },
      payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
    });
    expect(api.pricingV2Writes[1]!.body).toMatchObject({
      currency: "EUR",
      rooms: [
        {
          roomTypeId,
          revision: 1,
          capacity: { total: 2, adults: 2, children: 1 },
          offers: [{ price: { calendar: { base: { mode: "flat", amountMinor: "17550" } } } }],
        },
      ],
    });
    // The publication's charge declaration is the final-price confirmation: no legacy write.
    expect(api.confirmationWrites).toEqual([]);
    expect(api.calendarWrites).toEqual([]);

    await page.getByRole("textbox", { name: "Available Garden Suite rooms" }).fill("2");
    await page.getByRole("textbox", { name: "Minimum stay" }).fill("3");
    await page.getByRole("button", { name: "Review impact" }).click();

    await expect(
      page.getByRole("listitem").filter({ hasText: "Default minimum stay changes" }),
    ).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Starting room availability decreases" }),
    ).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
    await assertHealthy();
    expect(api.calendarDrafts).toHaveLength(1);
    expect(api.previewWrites).toEqual([
      {
        expectedCalendarRevision: 2,
        expectedPropertyProfileRevision: 7,
        schedule: { mode: "year_round", periods: [] },
        defaultMinimumStayNights: 3,
        roomTypeLimits: [
          {
            roomTypeId,
            expectedRoomFactsRevision: 3,
            expectedRoomUnitsRevision: 5,
            startingSellableLimitCount: 2,
          },
        ],
      },
    ]);

    await page
      .getByRole("checkbox", {
        name: /I reviewed this impact and want to create the starting calendar/,
      })
      .check();
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page).toHaveURL(/[?&]step=guest_experience(?:&|$)/);
    expect(api.calendarWrites).toHaveLength(1);
    expect(api.calendarWrites[0]).toMatchObject({
      ...api.previewWrites[0],
      impactConfirmation: {
        contractVersion: PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
        proposalFingerprint: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        token: "signed-calendar-impact-token",
      },
    });
    expect(api.calendarWrites[0]).not.toHaveProperty("organizationId");
    expect(api.calendarWrites[0]).not.toHaveProperty("propertyId");
    expect(api.calendarWrites[0]).not.toHaveProperty("audit");
    expect(api.calendarWrites[0]).not.toHaveProperty("idempotencyKey");
    expect(api.calendarIdempotencyKeys).toHaveLength(1);
    expect(api.materializationWrites).toEqual([
      expect.objectContaining({
        expectedCalendarRevision: 3,
        horizon: expect.objectContaining({
          from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          through: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      }),
    ]);
    expect(api.forbiddenCalls).toEqual([]);
    expect(api.unexpectedCalls).toEqual([]);
    await assertHealthy();
  });

  test("keeps recurring calendar validation keyboard-focused and contained on mobile", async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await primeBrowserState(page);
    await mockAuthSession(page);
    const api = await mockPricingCalendarApis(page);
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto(setupUrl(baseURL, "calendar"));
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    const recurring = page.getByRole("radio", { name: "Only during parts of the year" });
    await recurring.focus();
    await page.keyboard.press("Space");
    await expect(recurring).toBeChecked();
    await page.getByRole("button", { name: "Review impact" }).click();

    const firstMonth = page.getByRole("combobox", { name: "First open night month" });
    await expect(firstMonth).toBeFocused();
    await expect(page.getByText("Choose a valid first open night.")).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    expect(api.previewWrites).toEqual([]);
    expect(api.calendarWrites).toEqual([]);
    expect(api.forbiddenCalls).toEqual([]);
    await assertHealthy();
  });
});

async function mockPricingCalendarApis(page: Page) {
  let sessionRevision = 7;
  let publication: Record<string, unknown> | null = null;
  let pricingDraft: Record<string, any> | null = null;
  let confirmationRevision = 0;
  let confirmedFingerprint: string | null = null;
  let acceptedCalendar: Record<string, unknown> | null = null;
  const draftRevisions = new Map<PropertySetupStepId, number>();
  const drafts = new Map<PropertySetupStepId, PropertySetupStepDraft>();
  const pricingDrafts: Record<string, unknown>[] = [];
  const calendarDrafts: Record<string, unknown>[] = [];
  const pricingV2Writes: { request: string; body: Record<string, unknown> }[] = [];
  const confirmationWrites: Record<string, unknown>[] = [];
  const previewWrites: Record<string, unknown>[] = [];
  const calendarWrites: Record<string, unknown>[] = [];
  const calendarIdempotencyKeys: string[] = [];
  const materializationWrites: Record<string, unknown>[] = [];
  const forbiddenCalls: string[] = [];
  const unexpectedCalls: string[] = [];

  await page.route(
    /\/api\/hotel-setup\/(?:imports\/prepared|properties\/[^/]+\/import)(?:\?|$)/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      await route.fulfill({ headers: corsHeaders(route), json: { import: null } });
    },
  );

  // The Guest experience step opens after the calendar with no saved guest rules.
  await page.route(
    new RegExp(`/api/booking/properties/${propertyId}/guest-rules(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (route.request().method() !== "GET") return unexpected(route, unexpectedCalls);
      await ok(route, { current: null });
    },
  );

  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    // The Guest experience step, opened after the calendar, reads its own booking rules.
    const nextStepRead =
      request.method() === "GET" &&
      pathname === `/api/booking/properties/${propertyId}/guest-rules`;
    if (
      !nextStepRead &&
      (/^\/api\/hotel-setup\/(?:tracks|handoffs)(?:\/|$)/.test(pathname) ||
        /^\/api\/(?:booking|finance|distribution)\//.test(pathname))
    ) {
      forbiddenCalls.push(`${request.method()} ${pathname}`);
    }
  });

  await page.route(
    new RegExp(
      `/api/hotel-setup/properties/${propertyId}/(?:route|profile|setup-drafts/[^/?]+)(?:\\?|$)`,
    ),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/route") && request.method() === "GET") {
        const base = createPropertySetupRouteMock({
          propertyId,
          selectedTracks: ["hotel_operations"],
          resumeStepId: "pricing",
          stepStates: {
            present_hotel: "complete",
            booking_design: "complete",
            rooms: "complete",
            payments: "complete",
            ...(publication ? { pricing: "complete" as const } : {}),
          },
        });
        const model = {
          ...base,
          sessionRevision,
          steps: base.steps.map((step) => ({
            ...step,
            state: drafts.has(step.stepId) ? ("draft" as const) : step.state,
            draft: drafts.get(step.stepId) ?? null,
          })),
        } satisfies PropertySetupRouteReadModel;
        await route.fulfill({ status: 200, headers: corsHeaders(route), json: model });
        return;
      }
      if (pathname.endsWith("/profile") && request.method() === "GET") {
        await route.fulfill({ status: 200, headers: corsHeaders(route), json: propertyProfile() });
        return;
      }
      const stepId = pathname.split("/").at(-1) as PropertySetupStepId;
      if ((stepId === "pricing" || stepId === "calendar") && request.method() === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const revision = (draftRevisions.get(stepId) ?? 0) + 1;
        draftRevisions.set(stepId, revision);
        sessionRevision += 1;
        drafts.set(stepId, {
          stepId,
          payload: body.payload as PropertySetupStepDraft["payload"],
          dirtyFields: body.dirtyFields as PropertySetupStepDraft["dirtyFields"],
          baseRevisions: body.expectedBaseRevisions as PropertySetupStepDraft["baseRevisions"],
          piiClassification: "potential_incidental_pii",
          retentionExpiresAt: "2026-11-01T00:00:00.000Z",
          revision,
          updatedAt: acceptedAt,
        } as PropertySetupStepDraft);
        (stepId === "pricing" ? pricingDrafts : calendarDrafts).push(body);
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            contractVersion: "property-setup-draft.v1",
            sessionId,
            stepId,
            selectedTracks: ["hotel_operations"],
            trackRevision: 3,
            sessionRevision,
            draftRevision: revision,
            retentionExpiresAt: "2026-11-01T00:00:00.000Z",
            updatedAt: acceptedAt,
            replayed: false,
          },
        });
        return;
      }
      await unexpected(route, unexpectedCalls);
    },
  );

  await page.route(new RegExp(`/api/pms/(?:setup/)?properties/${propertyId}/.*`), async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname.endsWith("/pricing-source/currency-capabilities") && method === "GET") {
      await ok(route, {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: [
          { code: "EUR", scale: 2 },
          { code: "USD", scale: 2 },
        ],
      });
      return;
    }
    if (pathname.endsWith("/room-types") && method === "GET") {
      await ok(route, roomList());
      return;
    }
    if (pathname.endsWith(`/room-types/${roomTypeId}/capacity`) && method === "GET") {
      await ok(route, {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomUnitsRevision: 5,
        activeUnitCount: 4,
        capturedAt: acceptedAt,
      });
      return;
    }
    if (pathname.endsWith(`/room-types/${roomTypeId}/units`) && method === "GET") {
      await ok(route, {
        items: Array.from({ length: 4 }, (_, index) => ({
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          propertyId,
          roomTypeId,
          roomUnitId: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`,
          lifecycle: "active",
          operationalLabel: `Garden Suite ${index + 1}`,
          operationalLabelStatus: "verified",
        })),
      });
      return;
    }
    if (pathname.endsWith("/pricing-source") && method === "GET") {
      await ok(route, pricingSnapshot(4, "160.00"));
      return;
    }
    if (pathname.endsWith("/pricing-source/recurring-booking-evidence") && method === "GET") {
      await ok(route, recurringPricing());
      return;
    }
    if (pathname.endsWith("/mandatory-charge-confirmation") && method === "GET") {
      if (!confirmedFingerprint) {
        await ok(route, { outcome: "missing", organizationId, propertyId });
        return;
      }
      await ok(route, {
        outcome: "available",
        organizationId,
        propertyId,
        evidence: confirmationEvidence(confirmedFingerprint, confirmationRevision),
      });
      return;
    }
    const pricingV2 = pathname.match(new RegExp(`/pricing-v2(/.*)?$`));
    if (pricingV2) {
      const suffix = pricingV2[1] ?? "";
      const body = (method === "GET" ? {} : request.postDataJSON()) as Record<string, any>;
      const write = (name: string) =>
        pricingV2Writes.push({
          request: `${method} ${name}`,
          body,
        });
      if (suffix === "" && method === "GET") {
        if (!publication) {
          await route.fulfill({
            status: 404,
            headers: corsHeaders(route),
            json: { code: "not_found" },
          });
        } else await ok(route, publication);
        return;
      }
      const terms = suffix.match(/^\/drafts\/[^/]+\/rooms\/([^/]+)\/offers\/([^/]+)\/terms$/);
      if (terms && method === "PUT") {
        write(`/drafts/:id/rooms/${terms[1]}/offers/:offer/terms`);
        await ok(route, {
          roomTypeId: terms[1],
          offerId: decodeURIComponent(terms[2]!),
          revision: "66666666-6666-4666-8666-666666666666",
          cancellation: body.cancellation,
          payment: body.payment,
        });
        return;
      }
      if (suffix === "/prepare" && method === "POST") {
        write("/prepare");
        await ok(route, {
          sources: pricingSources(),
          effectiveSources: pricingSources(),
          snapshot: {
            currency: body.currency,
            rooms: body.rooms,
            ownerReferences: { finance: `finance.pricing.v2:${"1".repeat(64)}` },
          },
        });
        return;
      }
      if (/^\/drafts\/[^/]+$/.test(suffix) && method === "PUT") {
        write("/drafts/:id");
        pricingDraft = {
          ...body,
          draftId: suffix.split("/")[2],
          revision: body.expectedDraftRevision + 1,
        };
        await ok(route, { revision: body.expectedDraftRevision + 1 });
        return;
      }
      if (/^\/drafts\/[^/]+\/charge-review$/.test(suffix) && method === "GET" && pricingDraft) {
        await ok(route, {
          draftId: pricingDraft.draftId,
          snapshot: pricingDraft.snapshot,
          revision: pricingDraft.revision,
          baseRevision: pricingDraft.baseRevision,
          sources: pricingDraft.sources,
          effectiveSources: pricingDraft.effectiveSources,
          stale: false,
          fingerprint: "2".repeat(64),
          declaration: "all_mandatory_charges_included",
        });
        return;
      }
      if (suffix === "/charges" && method === "POST") {
        write("/charges");
        await ok(route, {
          id: "77777777-7777-4777-8777-777777777777",
          fingerprint: body.claimedFingerprint,
          declaration: body.declaration,
        });
        return;
      }
      if (suffix === "/publish" && method === "POST") {
        write("/publish");
        publication = {
          ...body.snapshot,
          revision: body.expectedRevision + 1,
          sources: body.sources,
          stale: false,
        };
        await ok(route, { revision: body.expectedRevision + 1, replayed: false });
        return;
      }
    }
    if (pathname.endsWith("/mandatory-charge-confirmation") && method === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      confirmationWrites.push(body);
      confirmedFingerprint = body.claimedPricingSourceFingerprint as string;
      confirmationRevision += 1;
      await ok(route, {
        contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
        outcome: "confirmed",
        evidence: confirmationEvidence(confirmedFingerprint, confirmationRevision),
        acceptedAt,
      });
      return;
    }
    if (pathname.endsWith("/operating-calendar") && method === "GET") {
      await ok(route, {
        sourceStatus: "current",
        sourceConflicts: [],
        configuration: acceptedCalendar ?? currentCalendar(),
      });
      return;
    }
    if (pathname.endsWith("/operating-calendar/impact-preview") && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      previewWrites.push(body);
      await ok(route, impactPreview());
      return;
    }
    if (pathname.endsWith("/operating-calendar") && method === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      calendarWrites.push(body);
      calendarIdempotencyKeys.push(request.headers()["idempotency-key"] ?? "");
      acceptedCalendar = acceptedCalendarConfiguration(body);
      await ok(route, {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        outcome: "updated",
        configuration: acceptedCalendar,
        acceptedAt,
      });
      return;
    }
    if (pathname.endsWith("/inventory-materialization") && method === "POST") {
      const body = request.postDataJSON() as {
        expectedCalendarRevision: number;
        horizon: { from: string; through: string };
      };
      materializationWrites.push(body);
      await ok(route, {
        ok: true,
        outcome: "applied",
        coverage: {
          materializedRevision: body.expectedCalendarRevision,
          coverageFrom: body.horizon.from,
          coverageThrough: body.horizon.through,
        },
      });
      return;
    }
    await unexpected(route, unexpectedCalls);
  });

  return {
    pricingDrafts,
    calendarDrafts,
    pricingV2Writes,
    confirmationWrites,
    previewWrites,
    calendarWrites,
    calendarIdempotencyKeys,
    materializationWrites,
    forbiddenCalls,
    unexpectedCalls,
  };
}

function pricingSources() {
  return {
    room: `pms.pricing.rooms.v2:${"3".repeat(64)}`,
    terms: `booking.pricing.terms.v2:${"4".repeat(64)}`,
    finance: `finance.pricing.source.v2:${"5".repeat(64)}`,
  };
}

function confirmationEvidence(fingerprint: string, revision: number) {
  return {
    organizationId,
    propertyId,
    pricingSourceFingerprint: fingerprint,
    confirmationRevision: revision,
    confirmedAt: acceptedAt,
  };
}

function impactPreview() {
  return {
    contractVersion: PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
    propertyId,
    proposalFingerprint: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    sourceRevisions: {
      calendarRevision: 2,
      propertyProfile: { revision: 7, timeZone: "Europe/Berlin" },
      roomTypes: [
        {
          roomTypeId,
          roomFactsRevision: 3,
          roomUnitsRevision: 5,
          physicalCapacityCount: 4,
        },
      ],
      inventory: {
        materializedRevision: 2,
        coverageFrom: "2026-08-05",
        coverageThrough: "2027-08-05",
        dayCount: 366,
        inventoryFingerprint: "c".repeat(64),
        bookingFingerprint: "d".repeat(64),
        blockFingerprint: "e".repeat(64),
        overrideFingerprint: "f".repeat(64),
        activeReservationCount: 2,
      },
    },
    impact: {
      categories: ["default_minimum_stay_changes", "starting_availability_decreases"],
      summary: {
        closingDateCount: 0,
        openingDateCount: 0,
        availableRoomNightsRemoved: 1,
        availableRoomNightsAdded: 0,
        acceptedBookingCount: 2,
        acceptedBookedRoomNights: 4,
        blockedRoomNights: 1,
        ownerOverrideDateCount: 1,
        defaultMinimumStayChanged: true,
      },
      affectedDates: [],
      roomTypeChanges: [
        {
          roomTypeId,
          previousStartingSellableLimitCount: 3,
          proposedStartingSellableLimitCount: 2,
          availableRoomNightsDelta: -1,
        },
      ],
    },
    confirmation: {
      contractVersion: PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
      proposalFingerprint: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      token: "signed-calendar-impact-token",
      issuedAt: confirmationIssuedAt,
      expiresAt: confirmationExpiresAt,
    },
    generatedAt: confirmationIssuedAt,
  };
}

function acceptedCalendarConfiguration(body: Record<string, unknown>) {
  const roomTypeLimits = body.roomTypeLimits as Array<{
    roomTypeId: string;
    expectedRoomFactsRevision: number;
    expectedRoomUnitsRevision: number;
    startingSellableLimitCount: number;
  }>;
  return {
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    propertyId,
    calendarRevision: 3,
    source: createPmsOperatingCalendarSourceRevision(propertyId, 3),
    sourceInputs: {
      propertyProfile: {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: propertyId,
        revision: "profile:7",
      },
      propertyTimeZone: canonicalTimeZone(),
      roomBindings: roomTypeLimits.map((room) => ({
        roomTypeId: room.roomTypeId,
        sourceRoomFactsRevision: room.expectedRoomFactsRevision,
        sourceRoomUnitsRevision: room.expectedRoomUnitsRevision,
        physicalCapacityCount: 4,
        startingSellableLimitCount: room.startingSellableLimitCount,
      })),
    },
    schedule: body.schedule,
    defaultMinimumStayNights: body.defaultMinimumStayNights,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  };
}

async function primeBrowserState(page: Page) {
  await mockHotelSetupPrerequisites(
    page,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Test hotel group",
      propertyId,
      selectedTracks: ["hotel_operations", "creator_marketplace"],
    }),
  );
  await page.addInitScript(
    ({ selectedPropertyId }) => {
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
      localStorage.setItem("userType", "hotel");
      localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
    },
    { selectedPropertyId: propertyId },
  );
}

async function mockAuthSession(page: Page) {
  await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: null });
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId,
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@example.com",
          name: "Hotel Owner",
          phone: "+49 89 123456",
          profilePictureUrl: null,
          profilePictureMediaObjectId: null,
          status: "active",
        },
      },
    });
  });
}

function setupUrl(baseURL: string | undefined, step: PropertySetupStepId) {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo: "/marketplace",
    propertyId,
    step,
    _adaptive: "1",
  });
  if (!baseURL) return `/setup?${query.toString()}`;
  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(
    results.violations
      .filter(({ impact }) => impact === "critical" || impact === "serious")
      .map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) })),
  ).toEqual([]);
}

async function ok(route: Route, json: unknown) {
  await route.fulfill({ status: 200, headers: corsHeaders(route), json });
}

async function unexpected(route: Route, calls: string[]) {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  calls.push(`${request.method()} ${pathname}`);
  await route.fulfill({
    status: 404,
    headers: corsHeaders(route),
    json: { code: "unexpected_e2e_request" },
  });
}
