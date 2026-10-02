import {
  DescribeSecretCommand,
  ListSecretVersionIdsCommand,
  GetSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { beforeEach, expect, it, vi } from "vitest";
import { runHotelSetupReaderPreflight } from "./cli/hotelSetupReaderPreflight.js";
import { stageVerifiedHotelSetupReaderSecret } from "./hotelSetupReaderSecretCandidate.js";

vi.mock("./cli/hotelSetupReaderPreflight.js", () => ({ runHotelSetupReaderPreflight: vi.fn() }));
const secretArn =
  "arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/reader-database-url-ABC123";
const readerDatabaseUrl = `postgresql://vayada_next_hotel_setup_reader:${"p".repeat(36)}@database.example/target?sslmode=verify-full`;
const databaseEndpoint = "postgresql://database.example/target";
beforeEach(() => {
  vi.mocked(runHotelSetupReaderPreflight).mockReset().mockResolvedValue(0);
});

function fixture(change: (value: Record<string, unknown>, phase: string) => void = () => {}) {
  let value: CreateSecretCommand["input"];
  const send = vi.fn(
    async (
      command:
        | DescribeSecretCommand
        | ListSecretVersionIdsCommand
        | CreateSecretCommand
        | GetSecretValueCommand,
    ) => {
      let result: Record<string, unknown>;
      if (command instanceof DescribeSecretCommand)
        result = {
          ARN: secretArn,
          Name: "hotel-setup-command/prod/reader-database-url",
          VersionIdsToStages: {},
        };
      else if (command instanceof ListSecretVersionIdsCommand)
        result = { ARN: secretArn, Versions: [] };
      else if (command instanceof CreateSecretCommand) {
        value = command.input as typeof value;
        result = {
          ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${value.Name}-DEF456`,
          Name: value.Name,
          VersionId: value.ClientRequestToken,
        };
      } else {
        result = {
          ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${value!.Name}-DEF456`,
          VersionId: value!.ClientRequestToken,
          SecretString: value!.SecretString,
          VersionStages: ["AWSCURRENT"],
        };
      }
      change(result, command.constructor.name);
      return result;
    },
  );
  return {
    send,
    input: { secrets: { send } as never, secretArn, readerDatabaseUrl, databaseEndpoint },
  };
}

it("verifies native credentials and pins an unpublished raw URL version", async () => {
  const { send, input } = fixture();
  const { versionId, secretArn: candidateArn } = await stageVerifiedHotelSetupReaderSecret(input);
  expect(runHotelSetupReaderPreflight).toHaveBeenCalledWith({
    HOTEL_SETUP_COMMAND_READER_DATABASE_URL: readerDatabaseUrl,
    HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: databaseEndpoint,
  });
  expect(vi.mocked(runHotelSetupReaderPreflight).mock.invocationCallOrder[0]).toBeLessThan(
    send.mock.invocationCallOrder[0]!,
  );
  expect(versionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
    "DescribeSecretCommand",
    "ListSecretVersionIdsCommand",
    "CreateSecretCommand",
    "GetSecretValueCommand",
  ]);
  expect(send.mock.calls[2]![0].input).toEqual({
    Name: `hotel-setup-command/prod/reader-candidate/${versionId}`,
    ClientRequestToken: versionId,
    SecretString: readerDatabaseUrl,
    Description: "VAY-1092 reader candidate; not mapped to a service",
  });
  expect(send.mock.calls[3]![0].input).toEqual({
    SecretId: candidateArn,
    VersionId: versionId,
  });
});

it("rejects untrusted containers and failed reader preflight before any AWS call", async () => {
  for (const arn of [
    secretArn.replace("269416271598", "000000000000"),
    secretArn.replace("reader-database-url", "internal-token"),
    secretArn.replace("eu-west-1", "us-east-1"),
  ]) {
    const { send, input } = fixture();
    await expect(stageVerifiedHotelSetupReaderSecret({ ...input, secretArn: arn })).rejects.toThrow(
      "secret candidate failed",
    );
    expect(send).not.toHaveBeenCalled();
  }
  const { send, input } = fixture();
  vi.mocked(runHotelSetupReaderPreflight).mockResolvedValueOnce(1);
  await expect(stageVerifiedHotelSetupReaderSecret(input)).rejects.toThrow(
    "secret candidate failed",
  );
  expect(send).not.toHaveBeenCalled();
});

it("rejects populated, replaced or scheduled-for-deletion containers before writing", async () => {
  for (const drift of [
    { VersionIdsToStages: { old: ["AWSCURRENT"] } },
    { VersionIdsToStages: { abandoned: [] } },
    { ARN: secretArn.replace("ABC123", "XYZ999") },
    { Name: "hotel-setup-command/prod/internal-token" },
    { DeletedDate: new Date() },
  ]) {
    const { send, input } = fixture((result, phase) => {
      if (phase === "DescribeSecretCommand") Object.assign(result, drift);
    });
    await expect(stageVerifiedHotelSetupReaderSecret(input)).rejects.toThrow(
      "secret candidate failed",
    );
    expect(send).toHaveBeenCalledTimes(1);
  }
});

it("requires the exact candidate readback and sanitizes uncertain storage failures", async () => {
  for (const drift of [
    { ARN: "other-container" },
    { VersionId: "different-version" },
    { SecretString: "different-credential" },
  ]) {
    const { send, input } = fixture((result, phase) => {
      if (phase === "GetSecretValueCommand") Object.assign(result, drift);
    });
    await expect(stageVerifiedHotelSetupReaderSecret(input)).rejects.toThrow(
      "secret candidate failed",
    );
    expect(send).toHaveBeenCalledTimes(4); // No delete, relabel, promotion or retry.
  }
  for (const phase of [
    "DescribeSecretCommand",
    "ListSecretVersionIdsCommand",
    "CreateSecretCommand",
    "GetSecretValueCommand",
  ]) {
    const { send, input } = fixture((_result, actual) => {
      if (actual === phase) throw new Error(readerDatabaseUrl);
    });
    await expect(stageVerifiedHotelSetupReaderSecret(input)).rejects.toThrow(
      /^Hotel setup reader secret candidate failed$/,
    );
    expect(send).toHaveBeenCalledTimes(
      [
        "DescribeSecretCommand",
        "ListSecretVersionIdsCommand",
        "CreateSecretCommand",
        "GetSecretValueCommand",
      ].indexOf(phase) + 1,
    );
  }
});

it("rejects deprecated versions and unexamined empty pages before candidate creation", async () => {
  for (const drift of [
    { Versions: [{ VersionId: "deprecated", VersionStages: [] }] },
    { NextToken: "unexamined" },
    { ARN: "wrong-container" },
  ]) {
    const { send, input } = fixture((result, phase) => {
      if (phase === "ListSecretVersionIdsCommand") Object.assign(result, drift);
    });
    await expect(stageVerifiedHotelSetupReaderSecret(input)).rejects.toThrow(
      "secret candidate failed",
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].input).toEqual({
      SecretId: secretArn,
      IncludeDeprecated: true,
      MaxResults: 1,
    });
  }
});
