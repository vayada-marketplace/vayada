#!/usr/bin/env node
import { CreateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import pg from "pg";

import {
  PartnerAppRegistrationRefusal,
  PartnerRegistrationIncomplete,
  parsePartnerAppRegistrationArgs,
  refuseWebhookUntilSigning,
  registerPartnerAppIntoSecretStore,
} from "../platform/partnerAppRegistration.js";

// VAY-2436, VAY-2441: register a partner app once per environment. Only an ECS task reaches the live
// database, so it runs as the one-off task vayada-next-api-partner-app-registration, for example
//   node apps/api/dist/cli/registerPartnerApp.js --name "Creator Links" \
//     --redirect-uri https://…/admin/connect/vayada --redirect-uri https://…/hotel/connect/vayada \
//     --contact-email … --secret-name partner-apps/prod/creator-links-test --apply
// Without --apply it only prints what it would store. With --apply it saves the app and puts its client
// id and secret into a new AWS Secrets Manager secret (--secret-name) in one go, and prints only the
// client id: the secret never reaches output or logs. On the Mac that hands it to the partner,
// `partner:secret-to-keychain` copies it into the Keychain and deletes the Secrets Manager secret.
// Vayada keeps only the secret's SHA-256. Runs as the API login (TARGET_DATABASE_URL).
// Hand a secret over only when its client id has this task's "registered":true line.
// Exit codes: 0 done, 64 refused, 1 failed.

const print = (line: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout) =>
  stream.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<number> {
  const { apply, secretName, ...registration } = parsePartnerAppRegistrationArgs(
    process.argv.slice(2),
  );
  if (!apply) {
    print({ dryRun: true, wouldRegister: registration, secretName });
    return 0;
  }
  if (!secretName) throw new PartnerAppRegistrationRefusal("--apply needs --secret-name");
  refuseWebhookUntilSigning(registration);
  const databaseUrl = process.env["TARGET_DATABASE_URL"];
  if (!databaseUrl) throw new PartnerAppRegistrationRefusal("TARGET_DATABASE_URL is not set");
  const secrets = new SecretsManagerClient({});
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { appId, clientId } = await registerPartnerAppIntoSecretStore(
      pool,
      registration,
      secretName,
      async (Name, SecretString) => {
        try {
          await secrets.send(
            new CreateSecretCommand({
              Name,
              SecretString,
              Description:
                "Vayada partner app client id and secret, until partner:secret-to-keychain",
            }),
          );
        } catch (error) {
          if (error instanceof Error && error.name === "ResourceExistsException")
            throw new PartnerAppRegistrationRefusal(
              `${Name} already exists, from an earlier run: use a new name, and hand that secret over only if its client id has a "registered":true line`,
            );
          throw error;
        }
      },
    );
    print({ registered: true, name: registration.name, appId, clientId, secretName });
    return 0;
  } finally {
    await pool.end();
    secrets.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof PartnerAppRegistrationRefusal) {
      print({ refused: error.message }, process.stderr);
      process.exit(64);
    }
    if (error instanceof PartnerRegistrationIncomplete) {
      const { message, secretName, clientId, appSaved } = error;
      print({ failed: message, secretName, clientId, appSaved }, process.stderr);
      process.exit(1);
    }
    // Only the error's name: an AWS or database message could quote what was sent.
    print({ failed: error instanceof Error ? error.name : "unknown" }, process.stderr);
    process.exit(1);
  },
);
