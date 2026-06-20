import { describe, expect, it } from "vitest";

import {
  PLATFORM_BOOTSTRAP_CONFIRM,
  PLATFORM_ORGANIZATION_ID,
  PLATFORM_RESOURCE_ID,
  PLATFORM_RESOURCE_RELATIONSHIP,
  PLATFORM_WORKOS_ROLE_SLUG,
  mapLegacyUserStatus,
} from "./platformIdentityBootstrap.js";

describe("platform identity bootstrap constants", () => {
  it("uses stable platform identifiers and an explicit apply guard", () => {
    expect(PLATFORM_ORGANIZATION_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(PLATFORM_RESOURCE_ID).toBe("vayada");
    expect(PLATFORM_RESOURCE_RELATIONSHIP).toBe("operator");
    expect(PLATFORM_WORKOS_ROLE_SLUG).toBe("admin");
    expect(PLATFORM_BOOTSTRAP_CONFIRM).toBe("platform-identity-bootstrap:v1");
  });
});

describe("mapLegacyUserStatus", () => {
  it.each([
    ["verified", "active"],
    ["active", "active"],
    ["pending", "pending"],
    ["suspended", "suspended"],
    ["rejected", "deleted"],
    ["deleted", "deleted"],
    ["surprise", "pending"],
  ] as const)("maps %s to %s", (legacy, target) => {
    expect(mapLegacyUserStatus(legacy)).toBe(target);
  });
});
