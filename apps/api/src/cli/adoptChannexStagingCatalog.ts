import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { adoptChannexStagingCatalog } from "../domains/channexStagingCatalogAdoption.js";
import { StagingCatalogError } from "../domains/channexStagingCatalogEvidence.js";

try {
  const { values } = parseArgs({
    options: {
      "provider-property-id": { type: "string" },
      "booking-id": { type: "string" },
      "revision-id": { type: "string" },
      "channel-id": { type: "string" },
      "approval-ref": { type: "string" },
      "pre-import": { type: "boolean", default: false },
      "retained-revision": { type: "boolean", default: false },
      "apply-hash": { type: "string" },
    },
  });
  const result = await adoptChannexStagingCatalog(loadConfig(), {
    providerPropertyId: values["provider-property-id"] ?? "",
    bookingId: values["booking-id"] ?? "",
    revisionId: values["revision-id"] ?? "",
    channelId: values["channel-id"],
    retainedRevision: values["retained-revision"],
    approvalRef: values["approval-ref"] ?? "",
    applyHash: values["apply-hash"],
    preImport: values["pre-import"],
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error: error instanceof StagingCatalogError ? error.message : "staging_catalog_failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
