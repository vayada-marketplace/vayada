import { describe, expect, it } from "vitest";

import { requestContextFixtureCases } from "./requestContext.fixtures.js";

const requiredScopes = ["hotel", "creator", "affiliate", "platform"] as const;

describe("RequestContext contract fixtures", () => {
  it("covers allowed and denied cases for each required scope", () => {
    for (const scope of requiredScopes) {
      expect(
        requestContextFixtureCases.some(
          (fixture) => fixture.scope === scope && fixture.expected === "allowed",
        ),
      ).toBe(true);
      expect(
        requestContextFixtureCases.some(
          (fixture) => fixture.scope === scope && fixture.expected === "denied",
        ),
      ).toBe(true);
    }
  });

  it("models authorization through permissions and linked resources", () => {
    for (const fixture of requestContextFixtureCases) {
      const hasPermission = fixture.context.membership.permissions.includes(
        fixture.requirement.permission,
      );
      const hasResourceLink = fixture.context.linkedResources.some(
        (resource) =>
          resource.status === "active" &&
          resource.product === fixture.requirement.resource.product &&
          resource.resourceType === fixture.requirement.resource.resourceType &&
          resource.resourceId === fixture.requirement.resource.resourceId &&
          fixture.requirement.resource.allowedRelationships.includes(resource.relationship),
      );

      expect(hasPermission && hasResourceLink).toBe(fixture.expected === "allowed");
    }
  });

  it("does not model legacy authorization shortcuts", () => {
    for (const fixture of requestContextFixtureCases) {
      expect(fixture.context).not.toHaveProperty("userType");
      expect(fixture.context).not.toHaveProperty("isSuperadmin");
      expect(fixture.context).not.toHaveProperty("hotelId");
      expect(fixture.context.audit).not.toHaveProperty("compatibilityInputs");
      expect(fixture.context.actor.providerIdentity.provider).toBe("workos");
    }
  });
});
