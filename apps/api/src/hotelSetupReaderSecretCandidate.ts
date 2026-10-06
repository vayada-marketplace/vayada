import { randomUUID } from "node:crypto";
import {
  DescribeSecretCommand,
  ListSecretVersionIdsCommand,
  GetSecretValueCommand,
  CreateSecretCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { runHotelSetupReaderPreflight } from "./cli/hotelSetupReaderPreflight.js";

/** Separate release provisioner only; never inject this writer into the service. */
export async function stageVerifiedHotelSetupReaderSecret(input: {
  secrets: Pick<SecretsManagerClient, "send">;
  secretArn: string;
  readerDatabaseUrl: string;
  databaseEndpoint: string;
}) {
  try {
    // Pin the reviewed live container, including its suffix; never adopt a name replacement.
    if (
      !/^arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command\/prod\/reader-database-url-[A-Za-z0-9]{6}$/.test(
        input.secretArn,
      )
    )
      throw new Error();
    if (
      (await runHotelSetupReaderPreflight({
        HOTEL_SETUP_COMMAND_READER_DATABASE_URL: input.readerDatabaseUrl,
        HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: input.databaseEndpoint,
      })) !== 0
    )
      throw new Error();
    const container = await input.secrets.send(
      new DescribeSecretCommand({ SecretId: input.secretArn }),
    );
    if (
      container.ARN !== input.secretArn ||
      container.Name !== "hotel-setup-command/prod/reader-database-url" ||
      container.DeletedDate ||
      Object.keys(container.VersionIdsToStages ?? {}).length
    )
      throw new Error();
    const versions = await input.secrets.send(
      new ListSecretVersionIdsCommand({
        SecretId: input.secretArn,
        IncludeDeprecated: true,
        MaxResults: 1,
      }),
    );
    if (versions.ARN !== input.secretArn || versions.Versions?.length || versions.NextToken)
      throw new Error();
    const versionId = randomUUID();
    const name = `hotel-setup-command/prod/reader-candidate/${versionId}`;
    const version = await input.secrets.send(
      new CreateSecretCommand({
        Name: name,
        ClientRequestToken: versionId,
        SecretString: input.readerDatabaseUrl,
        Description: "VAY-1092 reader candidate; not mapped to a service",
      }),
    );
    if (
      version.Name !== name ||
      version.VersionId !== versionId ||
      !version.ARN ||
      !version.ARN.startsWith(`arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`) ||
      !/^[A-Za-z0-9]{6}$/.test(version.ARN.slice(-6))
    )
      throw new Error();
    const stored = await input.secrets.send(
      new GetSecretValueCommand({
        SecretId: version.ARN,
        VersionId: versionId,
      }),
    );
    if (
      stored.ARN !== version.ARN ||
      stored.VersionId !== versionId ||
      stored.SecretString !== input.readerDatabaseUrl
    )
      throw new Error();
    return { secretArn: version.ARN, versionId }; // Non-secret references only.
  } catch {
    // AWS/pg diagnostics can contain credential values. An uncertain candidate
    // stays unpublished for inspection; never delete, retry adoption or promote it.
    throw new Error("Hotel setup reader secret candidate failed");
  }
}
