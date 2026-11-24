#!/usr/bin/env node
import {
  DeleteSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import {
  PartnerSecretHandoverError,
  copyPartnerSecretToKeychain,
  macosKeychain,
} from "../platform/partnerSecretToKeychain.js";

// VAY-2441: after the registration task (registerPartnerApp.ts), on the Mac that hands the partner
// app's credentials over, with the Vayada AWS login (check the account first):
//   aws sts get-caller-identity --profile vayada
//   AWS_PROFILE=vayada AWS_REGION=eu-west-1 npm run partner:secret-to-keychain -w vayada-api -- \
//     --secret-name partner-apps/prod/creator-links-test
// It copies the client id and secret (and the webhook signing secret, when there is one) into the
// Keychain as VAYADA_CLIENT_ID, VAYADA_CLIENT_SECRET and VAYADA_WEBHOOK_SECRET, checks them there,
// then deletes the Secrets Manager secret for good. It prints only the client id and setting names,
// including any it replaced or that an earlier app left. Check the client id matches the registration
// task's "registered":true line first: a secret from a failed run belongs to no app.
// Exit codes: 0 done, 1 stopped. Until the last step the secret stays, so running it again is safe.

const print = (line: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout) =>
  stream.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<number> {
  const [flag, secretName, ...rest] = process.argv.slice(2);
  if (flag !== "--secret-name" || !secretName || rest.length > 0)
    throw new PartnerSecretHandoverError("Usage: --secret-name partner-apps/prod/<app>");
  if (process.platform !== "darwin")
    throw new PartnerSecretHandoverError("This runs only on a Mac: it writes the macOS Keychain");
  const client = new SecretsManagerClient({});
  try {
    const result = await copyPartnerSecretToKeychain({
      secretName,
      keychain: macosKeychain(),
      source: {
        read: async (SecretId) => {
          const secret = await client.send(new GetSecretValueCommand({ SecretId }));
          if (!secret.SecretString)
            throw new PartnerSecretHandoverError("The secret holds no text");
          return secret.SecretString;
        },
        delete: async (SecretId) => {
          await client.send(
            new DeleteSecretCommand({ SecretId, ForceDeleteWithoutRecovery: true }),
          );
        },
      },
    });
    print({ copied: true, ...result, keychainService: "toolbox-env", deleted: secretName });
    return 0;
  } finally {
    client.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof PartnerSecretHandoverError) {
      print({ stopped: error.message }, process.stderr);
      process.exit(1);
    }
    // Only the error's name: an AWS message could quote what was sent.
    print({ failed: error instanceof Error ? error.name : "unknown" }, process.stderr);
    process.exit(1);
  },
);
