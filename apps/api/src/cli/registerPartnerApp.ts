#!/usr/bin/env node
import { open, rm } from "node:fs/promises";

import pg from "pg";

import { deriveWebhookSigningSecret, parseWebhookSigningKey } from "../domains/partnerWebhooks.js";

import {
  PartnerAppRegistrationRefusal,
  parsePartnerAppRegistrationArgs,
  registerPartnerApp,
} from "../platform/partnerAppRegistration.js";

// VAY-2436: register a partner app once per environment, for example
//   partner:register-app:dist -- --name "Creator Links" --redirect-uri https://…/callback \
//     --webhook-url https://…/webhooks/vayada --contact-email … --secret-file /tmp/partner.json --apply
// Without --apply it only prints what it would store. With --apply it prints the client id and
// writes the client id and secret to --secret-file (a new file only its owner can read; never to
// stdout, which may end up in logs). Hand them to the partner over a private channel and delete the
// file; Vayada keeps only the secret's SHA-256. With --webhook-url the file also holds the webhook
// signing secret (VAY-2438), derived from PARTNER_WEBHOOK_SIGNING_KEY and never stored, so that key
// must be set. Runs as the API login (TARGET_DATABASE_URL).
// Exit codes: 0 done, 64 refused, 1 failed.

const print = (line: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout) =>
  stream.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<number> {
  const { apply, secretFile, ...registration } = parsePartnerAppRegistrationArgs(
    process.argv.slice(2),
  );
  if (!apply) {
    print({ dryRun: true, wouldRegister: registration });
    return 0;
  }
  if (!secretFile) throw new PartnerAppRegistrationRefusal("--apply needs --secret-file");
  const databaseUrl = process.env["TARGET_DATABASE_URL"];
  if (!databaseUrl) throw new PartnerAppRegistrationRefusal("TARGET_DATABASE_URL is not set");
  const signingKey = parseWebhookSigningKey(process.env["PARTNER_WEBHOOK_SIGNING_KEY"]);
  if (registration.webhookUrl && !signingKey)
    throw new PartnerAppRegistrationRefusal("--webhook-url needs PARTNER_WEBHOOK_SIGNING_KEY");
  // Create the file first ("wx": never an existing one), so a secret is never stored without a copy.
  const file = await open(secretFile, "wx", 0o600);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let written = false;
  try {
    const { appId, clientId, clientSecret } = await registerPartnerApp(pool, registration);
    // A new app's webhook signing secret is version 1 (external_api_clients.webhook_secret_version).
    const webhookSigningSecret =
      signingKey && registration.webhookUrl
        ? deriveWebhookSigningSecret(signingKey, clientId, 1)
        : undefined;
    await file.writeFile(`${JSON.stringify({ clientId, clientSecret, webhookSigningSecret })}\n`);
    written = true;
    print({ registered: true, name: registration.name, appId, clientId, secretFile });
    return 0;
  } finally {
    await file.close();
    if (!written) await rm(secretFile, { force: true });
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
