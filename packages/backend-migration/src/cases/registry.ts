import { checkBookingCheckoutParity } from "./bookingCheckout/parity.js";
import { transformBookingCheckout } from "./bookingCheckout/transform.js";
import { checkDistributionBookabilityParity } from "./distributionBookability/parity.js";
import { transformDistributionBookability } from "./distributionBookability/transform.js";
import { checkFinanceParity } from "./finance/parity.js";
import { transformFinance } from "./finance/transform.js";
import { checkIdentityOrganizationLinksParity } from "./identityOrganizationLinks/parity.js";
import { transformIdentityOrganizationLinks } from "./identityOrganizationLinks/transform.js";
import { checkIntelligenceParity } from "./intelligence/parity.js";
import { checkMarketplaceParity } from "./marketplace/parity.js";
import { transformMarketplace } from "./marketplace/transform.js";
import { checkPlatformJobsEventsAuditParity } from "./platformJobsEventsAudit/parity.js";
import { transformPlatformJobsEventsAudit } from "./platformJobsEventsAudit/transform.js";
import { checkPmsOperationsParity } from "./pmsOperations/parity.js";
import { transformPmsOperations } from "./pmsOperations/transform.js";
import { checkPropertyCatalogPublicProfilesParity } from "./propertyCatalogPublicProfiles/parity.js";
import { transformPropertyCatalogPublicProfiles } from "./propertyCatalogPublicProfiles/transform.js";
import type { FixtureCaseRegistration, TransformHandler } from "./types.js";
import type { ParityHandler } from "../parityTypes.js";

const fixtureCases: FixtureCaseRegistration[] = [
  {
    fixtureCase: "identity-organization-links",
    transform: transformIdentityOrganizationLinks,
    parityHandlers: [checkIdentityOrganizationLinksParity],
  },
  {
    fixtureCase: "property-catalog-public-profiles",
    transform: transformPropertyCatalogPublicProfiles,
    parityHandlers: [checkPropertyCatalogPublicProfilesParity],
  },
  {
    fixtureCase: "booking-checkout",
    transform: transformBookingCheckout,
    parityHandlers: [checkBookingCheckoutParity],
  },
  {
    fixtureCase: "finance",
    transform: transformFinance,
    parityHandlers: [checkFinanceParity],
  },
  {
    fixtureCase: "pms-operations",
    transform: transformPmsOperations,
    parityHandlers: [checkPmsOperationsParity],
  },
  {
    fixtureCase: "marketplace",
    transform: transformMarketplace,
    parityHandlers: [checkMarketplaceParity],
  },
  {
    fixtureCase: "distribution-bookability",
    transform: transformDistributionBookability,
    parityHandlers: [checkDistributionBookabilityParity],
  },
  {
    fixtureCase: "intelligence",
    parityHandlers: [checkIntelligenceParity],
  },
  {
    fixtureCase: "platform-jobs-events-audit",
    transform: transformPlatformJobsEventsAudit,
    parityHandlers: [checkPlatformJobsEventsAuditParity],
  },
];

const fixtureCaseRegistry = new Map(
  fixtureCases.map((registration) => [registration.fixtureCase, registration]),
);

export function getFixtureCaseRegistration(
  fixtureCase: string,
): FixtureCaseRegistration | undefined {
  return fixtureCaseRegistry.get(fixtureCase);
}

export function getTransformHandler(fixtureCase: string): TransformHandler | undefined {
  return getFixtureCaseRegistration(fixtureCase)?.transform;
}

export function getParityHandlers(fixtureCase: string): ParityHandler[] {
  return getFixtureCaseRegistration(fixtureCase)?.parityHandlers ?? [];
}
