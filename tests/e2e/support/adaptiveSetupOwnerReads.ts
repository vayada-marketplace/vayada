import { expect, type Page } from "@playwright/test";
import { createMarketplaceHotelCollaborationPreferencesEvidence } from "@vayada/domain-marketplace";
import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_PRICING_CONTRACT_VERSION,
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsCanonicalIanaTimeZone,
} from "@vayada/domain-pms";
import { corsHeaders, fulfillCorsPreflight } from "../marketplace-web/utils/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const organizationId = "11111111-1111-4111-8111-111111111111";
const roomTypeId = "33333333-3333-4333-8333-333333333333";
const planId = "44444444-4444-4444-8444-444444444444";
const acceptedAt = "2026-08-04T12:00:00.000Z";

// Shell navigation mounts the real owner forms. Keep reads valid and reject any
// writes; step-specific suites exercise editing and canonical persistence.
export async function mockAdaptiveSetupOwnerReads(page: Page) {
  const reads: Record<string, unknown> = {
    [`/api/booking/properties/${propertyId}/booking-guest-policy`]: {
      contractVersion: "booking-guest-policy.v1",
      organizationId,
      propertyId,
      supportedLanguages: ["en", "de", "fr", "es", "id", "nl"],
      current: null,
      composition: null,
      draft: {
        defaultGuestLanguage: null,
        childrenEnabled: null,
        adultAgeThreshold: null,
        phoneRequired: true,
        arrivalTimeEnabled: false,
        specialRequestsEnabled: true,
        checkInTime: null,
        checkOutTime: null,
      },
    },
    [`/api/hotel-setup/properties/${propertyId}/profile`]: propertyProfile(),
    [`/api/marketplace/properties/${propertyId}/hotel-collaboration-preferences`]: {
      contractVersion: "marketplace-hotel-collaboration-preferences.v1",
      propertyId,
      revision: 0,
      sourceRevision: "preferences:0",
      preferences: null,
      readiness: createMarketplaceHotelCollaborationPreferencesEvidence(propertyId, 0, null),
    },
    [`/api/booking/properties/${propertyId}/booking-design`]: {
      contractVersion: "booking-design.v1",
      propertyId,
      revision: 1,
      choices: { primaryColor: "#4F46E5", fontPairing: "modern-minimalist" },
      createdAt: acceptedAt,
    },
    [`/api/booking/properties/${propertyId}/booking-design/readiness`]: {
      outcome: "blocked",
      organizationId,
      propertyId,
      blocker: { code: "booking_design_missing", evidencePort: "design" },
    },
    [`/api/pms/setup/properties/${propertyId}/room-types`]: roomList(),
    [`/api/pms/properties/${propertyId}/room-types`]: roomList(),
    [`/api/pms/setup/properties/${propertyId}/room-types/${roomTypeId}/capacity`]: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomUnitsRevision: 5,
      activeUnitCount: 4,
      capturedAt: acceptedAt,
    },
    [`/api/pms/setup/properties/${propertyId}/room-types/${roomTypeId}/units`]: {
      items: Array.from({ length: 4 }, (_, index) => ({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomUnitId: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`,
        lifecycle: "active",
        operationalLabel: `Suite ${index + 1}`,
        operationalLabelStatus: "verified",
      })),
    },
    [`/api/pms/properties/${propertyId}/operating-calendar`]: {
      sourceStatus: "current",
      sourceConflicts: [],
      configuration: currentCalendar(),
    },
    [`/api/pms/properties/${propertyId}/pricing-source`]: pricingSnapshot(4, "160.00"),
    [`/api/pms/properties/${propertyId}/pricing-source/currency-capabilities`]: {
      contractVersion: "pms-pricing-currency-capabilities.v1",
      supportedCurrencies: [{ code: "EUR", scale: 2 }],
    },
    [`/api/pms/properties/${propertyId}/pricing-source/recurring-booking-evidence`]:
      recurringPricing(),
    [`/api/pms/properties/${propertyId}/mandatory-charge-confirmation`]: {
      outcome: "missing",
      organizationId,
      propertyId,
    },
  };
  for (const [path, json] of Object.entries(reads)) {
    await page.route(
      (url) => url.pathname === path,
      async (route) => {
        if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
        expect(route.request().method(), path).toBe("GET");
        await route.fulfill({ status: 200, headers: corsHeaders(route), json });
      },
    );
  }
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
}

export function roomList() {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    items: [
      {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomFactsRevision: 3,
        lifecycle: "active",
        facts: {
          name: "Garden Suite",
          description: "A quiet garden-facing suite.",
          category: "suite",
          occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
          beds: [{ type: "king", quantity: 1 }],
          bedrooms: 1,
          bathrooms: 1,
          bathroomType: "private",
          size: { value: 30, unit: "sqm" },
        },
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      },
    ],
  };
}

export function pricingPlan(flexibleRatePlanRevision: number, amountDecimal: string) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision,
    sourceRoomFactsRevision: 3,
    baseAmount: { amountDecimal, currency: "EUR" },
    cancellationTerms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  };
}

export function pricingSnapshot(flexibleRatePlanRevision: number, amountDecimal: string) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrency: {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: 2,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    },
    flexibleRatePlans: [pricingPlan(flexibleRatePlanRevision, amountDecimal)],
    capturedAt: acceptedAt,
  };
}

export function recurringPricing() {
  return {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrencyRevision: 2,
    optionalPricingAggregateRevision: 0,
    currency: "EUR",
    sources: [],
    capturedAt: acceptedAt,
  };
}

export function propertyProfile() {
  return {
    propertyId,
    profileRevision: 7,
    profile: {
      displayName: "Hotel Lindenhof",
      propertyType: "hotel",
      location: {
        streetAddress: "Lindenstrasse 4",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: 52.52,
        longitude: 13.405,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "approximate",
      },
      contacts: [],
    },
  };
}

export function canonicalTimeZone() {
  return parsePmsCanonicalIanaTimeZone("Europe/Berlin", {
    ownerDomain: "hotel_catalog",
    registryVersion: "e2e.v1",
    isCanonicalIanaTimeZone: (value) => value === "Europe/Berlin",
  })!;
}

export function currentCalendar() {
  return {
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    propertyId,
    calendarRevision: 2,
    source: createPmsOperatingCalendarSourceRevision(propertyId, 2),
    sourceInputs: {
      propertyProfile: {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: propertyId,
        revision: "profile:7",
      },
      propertyTimeZone: canonicalTimeZone(),
      roomBindings: [
        {
          roomTypeId,
          sourceRoomFactsRevision: 3,
          sourceRoomUnitsRevision: 5,
          physicalCapacityCount: 4,
          startingSellableLimitCount: 3,
        },
      ],
    },
    schedule: { mode: "year_round", periods: [] },
    defaultMinimumStayNights: 2,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  };
}
