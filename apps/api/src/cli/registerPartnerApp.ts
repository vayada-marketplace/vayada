#!/usr/bin/env node
import pg from "pg";

import {
  PartnerAppRegistrationRefusal,
  parsePartnerAppRegistrationArgs,
  registerPartnerApp,
} from "../platform/partnerAppRegistration.js";

// VAY-2436: register a partner app once per environment, for example
//   partner:register-app:dist -- --name "Creator Links" --redirect-uri https://…/callback \
//     --webhook-url https://…/webhooks/vayada --contact-email … --apply
// Without --apply it only prints what it would store. With --apply it prints the client id and the
// client secret once (hand them to the partner over a private channel); Vayada keeps only the
// secret's SHA-256. Runs as the API login (TARGET_DATABASE_URL). Exit codes: 0 done, 64 refused, 1 failed.

const print = (line: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout) =>
  stream.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<number> {
  const { apply, ...registration } = parsePartnerAppRegistrationArgs(process.argv.slice(2));
  if (!apply) {
    print({ dryRun: true, wouldRegister: registration });
    return 0;
  }
  const databaseUrl = process.env["TARGET_DATABASE_URL"];
  if (!databaseUrl) throw new PartnerAppRegistrationRefusal("TARGET_DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const registered = await registerPartnerApp(pool, registration);
    print({ registered: true, name: registration.name, ...registered });
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof PartnerAppRegistrationRefusal) {
      print({ refused: error.message }, process.stderr);
      process.exit(64);
    }
    print({ failed: error instanceof Error ? error.name : "unknown" }, process.stderr);
    process.exit(1);
  },
);
