import { expect, it, vi } from "vitest";
import { adoptChannexStagingCatalog } from "./channexStagingCatalogAdoption.js";
import { randomUUID } from "node:crypto";
import { importChannexStagingReservation } from "../jobs/channexBookings.js";
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

it("rejects retained recovery outside its canonical property and explicit catalog mode before I/O", async () => {
  const request = vi.fn();
  const retained = { ...input, retainedRevision: true, preImport: true, channelId: undefined };
  for (const scope of [
    { ...retained, preImport: false },
    { ...retained, channelId: input.channelId },
  ])
    await expect(adoptChannexStagingCatalog(config(), scope, request)).rejects.toThrow(
      "invalid_staging_catalog_scope",
    );
  const configured = config();
  await expect(
    adoptChannexStagingCatalog(
      {
        ...configured,
        channexManagement: {
          ...configured.channexManagement,
          stagingRestrictionsPropertyId: randomUUID(),
        },
      },
      retained,
      request,
    ),
  ).rejects.toThrow("invalid_staging_catalog_scope");
  await expect(
    importChannexStagingReservation(
      config(),
      {
        providerPropertyId: input.providerPropertyId,
        channelBookingId: input.bookingId,
        revision: input.revisionId,
        approvalRef: "VAY-2013:test",
        retainedRevision: true,
      },
      request,
    ),
  ).rejects.toThrow("invalid_staging_import_scope");
  expect(request).not.toHaveBeenCalled();
});
