import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type HotelSetupNativeSecretReader = (name: string, versionId: string) => Promise<unknown>;

/** Native setup only: no latest-version read, writes, adoption or automatic retry. */
export function createHotelSetupNativeSecretReader(
  client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({
    region: "eu-west-1",
    endpoint: "https://secretsmanager.eu-west-1.amazonaws.com",
    maxAttempts: 1,
  }),
): HotelSetupNativeSecretReader {
  return async (name, versionId) => {
    try {
      if (
        !/^hotel-setup-command\/prod\/(organization\/vayada_next_hotel_setup_org_|property\/vayada_next_hotel_setup_property_)[a-z0-9_]+$/.test(
          name,
        ) ||
        !/^[A-Za-z0-9-]{32,64}$/.test(versionId)
      )
        throw new Error();
      const result = await client.send(
        new GetSecretValueCommand({ SecretId: name, VersionId: versionId }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      const prefix = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`;
      if (
        result.Name !== name ||
        result.VersionId !== versionId ||
        !result.ARN?.startsWith(prefix) ||
        !/^[A-Za-z0-9]{6}$/.test(result.ARN.slice(prefix.length)) ||
        !result.SecretString ||
        result.SecretBinary
      )
        throw new Error();
      return JSON.parse(result.SecretString) as unknown;
    } catch {
      throw new Error("Hotel setup native secret unavailable");
    }
  };
}
