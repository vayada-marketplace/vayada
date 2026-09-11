import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { importChannexStagingReservation } from "../jobs/channexBookings.js";

try {
  const { values } = parseArgs({
    options: {
      "provider-property-id": { type: "string" },
      "booking-id": { type: "string" },
      "revision-id": { type: "string" },
      "approval-ref": { type: "string" },
    },
  });
  const result = await importChannexStagingReservation(loadConfig(), {
    providerPropertyId: values["provider-property-id"] ?? "",
    channelBookingId: values["booking-id"] ?? "",
    revision: values["revision-id"] ?? "",
    approvalRef: values["approval-ref"] ?? "",
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status !== "succeeded") process.exitCode = 1;
} catch {
  // Never echo configuration, database errors or provider response bodies.
  process.stderr.write("Staging import failed; verify scope, binding and runtime configuration.\n");
  process.exitCode = 1;
}
