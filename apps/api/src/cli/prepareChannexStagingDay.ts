import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { prepareChannexStagingDay } from "../domains/pmsChannexStagingDay.js";

try {
  const { values } = parseArgs({
    options: {
      "catalog-hash": { type: "string" },
      "approval-ref": { type: "string" },
      "apply-hash": { type: "string" },
    },
  });
  const result = await prepareChannexStagingDay(loadConfig(), {
    catalogHash: values["catalog-hash"] ?? "",
    approvalRef: values["approval-ref"] ?? "",
    applyHash: values["apply-hash"],
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("Staging day preparation rejected; verify exact scope and evidence.\n");
  process.exitCode = 1;
}
