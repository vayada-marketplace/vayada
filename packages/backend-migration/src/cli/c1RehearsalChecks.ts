#!/usr/bin/env node
import pg from "pg";

import { runC1RehearsalChecks } from "../c1RehearsalEvidence.js";

function parseArgs(argv: string[]): {
  connectionString: string;
  lookbackMinutes: number;
  pretty: boolean;
} {
  const args = argv.slice(2);
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let lookbackMinutes = 24 * 60;
  let pretty = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === "--lookback-minutes" && args[i + 1]) {
      const raw = args[++i]!;
      if (!/^\d+$/.test(raw)) {
        console.error("Error: --lookback-minutes must be a positive integer.");
        process.exit(1);
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error("Error: --lookback-minutes must be a positive integer.");
        process.exit(1);
      }
      lookbackMinutes = parsed;
    } else if (args[i] === "--pretty") {
      pretty = true;
    } else {
      console.error(`Error: unknown argument "${args[i]}".`);
      process.exit(1);
    }
  }

  if (!connectionString) {
    console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
    process.exit(1);
  }

  return { connectionString, lookbackMinutes, pretty };
}

const { connectionString, lookbackMinutes, pretty } = parseArgs(process.argv);
const client = new pg.Client({ connectionString });

try {
  await client.connect();
  const report = await runC1RehearsalChecks(client, { lookbackMinutes });
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
} finally {
  await client.end();
}
