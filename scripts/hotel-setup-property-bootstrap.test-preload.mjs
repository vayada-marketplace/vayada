// Local synthetic bootstrap proof only; never packaged in the production operational image.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { STSClient } from "@aws-sdk/client-sts";
import {
  SecretsManagerClient,
  DescribeSecretCommand,
  CreateSecretCommand,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
const mode = process.env.VAY1092_BOOTSTRAP_TEST_MODE;
let secret,
  writes = 0;
STSClient.prototype.send = async () => ({
  Account: mode === "account" ? "000000000000" : "269416271598",
});
SecretsManagerClient.prototype.send = async (command) => {
  if (command instanceof DescribeSecretCommand) {
    const e = new Error();
    e.name = "ResourceNotFoundException";
    throw e;
  }
  if (command instanceof CreateSecretCommand) {
    writes++;
    secret = {
      ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${command.input.Name}-123abc`,
      Name: command.input.Name,
      VersionId: command.input.ClientRequestToken,
      SecretString: command.input.SecretString,
    };
    if (mode === "publication") throw new Error("synthetic lost create response");
    return secret;
  }
  if (command instanceof GetSecretValueCommand && secret) return secret;
  throw new Error("Unexpected synthetic AWS request");
};
if (mode === "secondary")
  registerHooks({
    load(url, context, nextLoad) {
      if (url === "file:///proof/rollback/apps/api/dist/cli/hotelSetupPropertyPreflight.js")
        return {
          format: "module",
          shortCircuit: true,
          source:
            'export async function checkHotelSetupPropertyCredential(){throw new Error("synthetic rollback denial")}',
        };
      return nextLoad(url, context);
    },
  });
process.on("exit", () =>
  writeFileSync(process.env.VAY1092_BOOTSTRAP_TEST_RECEIPT, JSON.stringify({ writes, secret }), {
    mode: 0o600,
  }),
);
