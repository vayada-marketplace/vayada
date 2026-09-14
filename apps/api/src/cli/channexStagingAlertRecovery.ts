import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { stagingAlertRecovery } from "../domains/channexStagingAlertRecovery.js";

try {
  const { values } = parseArgs({
    options: {
      "alert-id": { type: "string" },
      "provider-property-id": { type: "string" },
      "booking-id": { type: "string" },
      "revision-id": { type: "string" },
      "canonical-booking-id": { type: "string" },
      "approval-ref": { type: "string" },
      execute: { type: "boolean", default: false },
    },
  });
  const result = await stagingAlertRecovery(loadConfig(), {
    alertId: values["alert-id"] ?? "",
    providerPropertyId: values["provider-property-id"] ?? "",
    channelBookingId: values["booking-id"] ?? "",
    revision: values["revision-id"] ?? "",
    canonicalBookingId: values["canonical-booking-id"] ?? "",
    approvalRef: values["approval-ref"] ?? "",
    execute: values.execute,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (values.execute && result.status !== "succeeded") process.exitCode = 1;
} catch {
  process.stderr.write(
    "Staging alert recovery rejected; verify approval, identity, expiry and runtime.\n",
  );
  process.exitCode = 1;
}
