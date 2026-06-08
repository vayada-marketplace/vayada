import { checkIdentityOrganizationLinksParity } from "./identityOrganizationLinks/parity.js";
import { transformIdentityOrganizationLinks } from "./identityOrganizationLinks/transform.js";
import { checkPropertyCatalogPublicProfilesParity } from "./propertyCatalogPublicProfiles/parity.js";
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
    parityHandlers: [checkPropertyCatalogPublicProfilesParity],
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
