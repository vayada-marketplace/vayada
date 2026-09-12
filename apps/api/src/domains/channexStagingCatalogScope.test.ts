import { expect, it, vi } from "vitest";
import { adoptChannexStagingCatalog } from "./channexStagingCatalogAdoption.js";
import { config, input } from "./channexStagingCatalogTestFixture.js";
it("rejects unsafe configuration and identifiers before I/O", async () => {
  const request = vi.fn();
  for (const change of [
    { backgroundWorkersEnabled: true },
    { apiRuntime: "legacy" as const },
    { channexManagement: { ...config().channexManagement, apiBaseUrl: "https://app.channex.io" } },
    {
      channexManagement: {
        ...config().channexManagement,
        capabilityModes: {
          ...config().channexManagement.capabilityModes,
          bookingSync: "mutating" as const,
        },
      },
    },
  ])
    await expect(
      adoptChannexStagingCatalog({ ...config(), ...change }, input, request),
    ).rejects.toThrow("invalid_staging_catalog_scope");
  await expect(
    adoptChannexStagingCatalog(config(), { ...input, revisionId: "../other" }, request),
  ).rejects.toThrow("invalid_staging_catalog_scope");
  expect(request).not.toHaveBeenCalled();
});
