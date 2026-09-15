import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  parseLegacyOwnerSetupCommand,
  type LegacyOwnerSetupCommand,
} from "./legacyOwnerSetupCommand.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = "a".repeat(64);
const now = new Date("2026-09-15T01:05:00.000Z");
const expected = {
  environment: "local" as const,
  targetDatabaseSha256: sha,
  source: {
    sourceRunId: `vay1351-${"a".repeat(24)}`,
    ledgerSha256: sha,
    sourceEnvironment: "local",
    sourceSchemaRevision: "synthetic-only",
    owners: Array.from({ length: 8 }, (_, i) => ({
      ownerId: id(i + 1),
      hotelId: id(i + 11),
      userOrdinal: i + 1,
      hotelOrdinal: i + 1,
      userSha256: sha,
      hotelSha256: sha,
    })),
  },
};
const fixture = (): LegacyOwnerSetupCommand => ({
  contractVersion: "legacy-owner-internal-setup.v1",
  commandId: id(99),
  environment: "local",
  issuedAt: "2026-09-15T01:01:00.000Z",
  expiresAt: "2026-09-15T01:15:00.000Z",
  targetDatabaseSha256: sha,
  sourceRunId: expected.source.sourceRunId,
  sourceLedgerSha256: sha,
  owners: expected.source.owners.map((source, i) => ({
    ...source,
    email: `Owner${i}@example.invalid`,
    name: i === 0 ? null : "Synthetic Owner",
    status: "pending",
    expectedTarget: "absent",
    targetBeforeSha256: sha,
    currentEvidenceSha256: sha,
    observedAt: "2026-09-15T01:00:00.000Z",
  })),
});
const parse = (command: unknown) =>
  parseLegacyOwnerSetupCommand(canonicalizeJson(command), expected, now);
const invalid = (action: () => unknown) =>
  expect(action).toThrow(/^LEGACY_OWNER_SETUP_COMMAND_INVALID$/);

describe("protected internal owner command", () => {
  it("preserves exact rows and hashes the entire canonical command in its own domain", () => {
    const command = fixture(),
      payload = canonicalizeJson(command),
      result = parse(command);
    expect(result.command).toEqual(command);
    expect(result.executable).toBe(false);
    expect(result.commandSha256).toBe(
      createHash("sha256")
        .update("vayada:legacy-owner-internal-setup:v1\0command\0")
        .update(payload)
        .digest("hex"),
    );
  });
  it("accepts an explicitly selected subset without manufacturing missing rows", () => {
    const command = fixture();
    command.owners = [command.owners[2]!];
    expect(parse(command).command.owners).toEqual(command.owners);
  });
  it.each(["email", "name", "currentEvidenceSha256", "targetBeforeSha256"])(
    "binds changed %s bytes",
    (key) => {
      const command = fixture(),
        before = parse(command).commandSha256;
      Object.assign(command.owners[0]!, {
        [key]: key.endsWith("Sha256") ? "b".repeat(64) : "other@example.invalid",
      });
      expect(parse(command).commandSha256).not.toBe(before);
    },
  );
  it.each([
    ["contractVersion", "legacy-pms-owner-evidence.v1"],
    ["commandId", "not-a-uuid"],
    ["environment", "production"],
    ["targetDatabaseSha256", "b".repeat(64)],
    ["sourceRunId", `vay1351-${"b".repeat(24)}`],
    ["sourceLedgerSha256", "b".repeat(64)],
    ["issuedAt", "2026-09-15T01:06:00.000Z"],
    ["expiresAt", now.toISOString()],
    ["expiresAt", "2026-09-15T01:16:00.001Z"],
    ["issuedAt", "2026-09-15T01:01:00Z"],
    ["expiresAt", "2026-02-30T01:15:00.000Z"],
    ["grantMarketplace", true],
  ])("rejects invalid root field %s", (key, value) =>
    invalid(() => parse({ ...fixture(), [key as string]: value })),
  );
  it.each([
    ["ownerId", id(80)],
    ["hotelId", id(90)],
    ["userOrdinal", 2],
    ["hotelOrdinal", 0],
    ["userSha256", "b".repeat(64)],
    ["hotelSha256", "b".repeat(64)],
    ["status", "active"],
    ["expectedTarget", "exact"],
    ["targetBeforeSha256", "invalid"],
    ["currentEvidenceSha256", null],
    ["observedAt", "2026-09-15T01:02:00.000Z"],
    ["observedAt", "2026-09-15T00:59:59.999Z"],
    ["email", " owner@example.invalid"],
    ["email", "no-at"],
    ["email", "x\0@example.invalid"],
    ["email", `${"x".repeat(250)}@example.invalid`],
    ["name", ""],
    ["name", "\0"],
    ["name", "x".repeat(257)],
    ["emailVerified", true],
    ["password", "secret-fixture"],
    ["memberships", []],
    ["providerUserId", "user_fixture"],
    ["createdAt", now.toISOString()],
  ])("rejects invalid owner field %s", (key, value) => {
    const command = fixture();
    Object.assign(command.owners[0]!, { [key as string]: value });
    invalid(() => parse(command));
  });
  it("rejects omitted, duplicate, unordered and empty owner entries", () => {
    const command = fixture();
    invalid(() => parse({ ...command, owners: [] }));
    invalid(() => parse({ ...command, owners: [...command.owners, command.owners[0]] }));
    invalid(() => parse({ ...command, owners: [command.owners[0], command.owners[0]] }));
    invalid(() => parse({ ...command, owners: [...command.owners].reverse() }));
    command.owners[1]!.email = command.owners[0]!.email;
    invalid(() => parse(command));
    const { name: _name, ...missingName } = command.owners[0]!;
    invalid(() => parse({ ...command, owners: [missingName] }));
  });
  it("rejects malformed/noncanonical JSON and sanitizes invalid Unicode", () => {
    for (const payload of [
      "{",
      "null",
      "[]",
      JSON.stringify(fixture()),
      canonicalizeJson(fixture()).replace('"name":null', '"name":"\\ud800"'),
    ])
      invalid(() => parseLegacyOwnerSetupCommand(payload, expected, now));
    invalid(() =>
      parseLegacyOwnerSetupCommand(canonicalizeJson(fixture()), expected, new Date(NaN)),
    );
  });
  it.each(["missing", "duplicate", "qa", "staging", "ordinal", "hash", "database"])(
    "rejects invalid trusted context: %s",
    (change) => {
      const context = structuredClone(expected);
      if (change === "missing") context.source.owners.pop();
      if (change === "duplicate") context.source.owners[1] = context.source.owners[0]!;
      if (change === "qa")
        context.source.owners[0]!.hotelId = "17621565-40b5-4ebc-8727-3a301ac947a2";
      if (change === "staging")
        context.source.owners[0]!.hotelId = "65f6b2fc-c783-4963-9d6b-a85f82319769";
      if (change === "ordinal") context.source.owners[0]!.userOrdinal = 1.5;
      if (change === "hash") context.source.owners[0]!.userSha256 = "bad";
      if (change === "database") context.targetDatabaseSha256 = "bad";
      invalid(() => parseLegacyOwnerSetupCommand(canonicalizeJson(fixture()), context, now));
    },
  );
});
