import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

import { getParityHandlers } from "./cases/registry.js";
import { checkIdStability, checkRowCounts } from "./parityUtils.js";
import type { ExpectedTarget, ParityConfig, ParityFinding, ParityReport } from "./parityTypes.js";

export type {
  ExpectedTarget,
  ParityCheckSeverity,
  ParityConfig,
  ParityFinding,
  ParityHandler,
  ParityHandlerContext,
  ParityReport,
} from "./parityTypes.js";

export async function runParityChecks(config: ParityConfig): Promise<ParityReport> {
  const startedAt = new Date().toISOString();
  const runId = `${config.environment}-${config.fixtureCase}-${Date.now()}`;
  const findings: ParityFinding[] = [];

  const expectedPath = join(
    config.fixturesDir,
    "cases",
    config.fixtureCase,
    "expected-target.json",
  );
  const expected: ExpectedTarget = JSON.parse(await readFile(expectedPath, "utf8"));

  const client = new pg.Client({ connectionString: config.connectionString });
  await client.connect();

  try {
    await checkRowCounts(client, expected, findings);
    await checkIdStability(client, expected, findings);

    for (const checkFixtureCaseParity of getParityHandlers(config.fixtureCase)) {
      await checkFixtureCaseParity({ client, expected, findings });
    }
  } finally {
    await client.end();
  }

  const finishedAt = new Date().toISOString();
  const failures = findings.filter((f) => f.severity === "fail").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;

  return {
    runId,
    environment: config.environment,
    fixtureCase: config.fixtureCase,
    startedAt,
    finishedAt,
    status: failures > 0 ? "failed" : "passed",
    summary: { failures, warnings },
    findings,
  };
}
