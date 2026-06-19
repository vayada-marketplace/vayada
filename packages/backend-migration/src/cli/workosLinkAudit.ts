#!/usr/bin/env node
import { runWorkosLinkAudit, WorkosLinkAuditError } from "../workosLinkAudit.js";

function parseArgs(argv: string[]): { connectionString: string } {
  const args = argv.slice(2);
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    }
  }

  return { connectionString };
}

const { connectionString } = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}

try {
  const result = await runWorkosLinkAudit({ connectionString });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof WorkosLinkAuditError) {
    console.error(
      JSON.stringify(
        {
          kind: "workos_link_audit",
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            missingTables: error.missingTables,
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  } else {
    throw error;
  }
}
