import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { readLegacyHistoricalBindingEvidenceSnapshot } from "./legacyHistoricalBindingEvidenceSnapshot.js";
import {
  APPROVED_SOURCE_RUN_ID,
  parseLegacyHistoricalBindingPreflightInput,
  runLegacyHistoricalBindingPreflight,
} from "./legacyHistoricalBindingPreflightRunner.js";

vi.mock("./legacyHistoricalBindingEvidenceSnapshot.js");
const read = vi.mocked(readLegacyHistoricalBindingEvidenceSnapshot);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signingKeys = generateKeyPairSync("ed25519");
const verificationKeys = new Map([["migration-production-2026-09", signingKeys.publicKey]]);
const domain = "vayada:vay2017-historical-binding-preflight:v1\0";
const pairs = [
  ["29f39aae-4ea8-4730-948a-c36780347750", "237e8ee7-3a88-474e-97b6-80fc953026e2"],
  ["26e9e98f-1f64-483f-8cb5-a5fa7499ba5d", "253dc0ba-6518-4117-86e4-b3d0da05b13d"],
  ["8f5919ed-4fc5-4d64-a65c-07486ec3f651", "50e2edff-0399-4171-8e3e-ac04ffd3df24"],
  ["c8efd685-527c-43da-a2f4-07e1b820b31e", "61937e72-4e7f-4028-82d2-00c33433b607"],
  ["7d3f6dcc-37f0-4446-bad8-7335819c180a", "aeab85ad-8193-4c3e-9a65-491d05391720"],
  ["6aca326e-9fb7-4139-a43c-d495c397700a", "cfcddb9b-9607-4f5e-8759-23111bb68ab7"],
  ["6810de91-f389-47ab-8f92-68abb2d8b163", "e13f3645-d50b-4788-bb04-9e68ece0d647"],
  ["b8efb175-7a94-49d5-98f9-1a6c28f6ec17", "fc18d06d-c752-4621-bc3f-65b17d682b18"],
] as const;

function rawInput() {
  const requests = Array.from({ length: 8 }, (_, index) => {
    const offset = index * 10;
    const [propertyId, externalPropertyId] = pairs[index]!;
    const source = {
      id: id(offset + 1),
      hotelId: propertyId,
      externalPropertyId,
      rowOrdinal: index + 1,
      rowChecksumSha256: "a".repeat(64),
    };
    const sourceRunId = APPROVED_SOURCE_RUN_ID;
    return {
      sourceRequest: {
        sourceRunId,
        sourceEnvironment: "preprod",
        sourceSchemaRevision: "c".repeat(40),
        sourceEvidenceSha256: "d".repeat(64),
        snapshotIdentifierSha256: "e".repeat(64),
        source,
      },
      bindingExpected: {
        sourceRunId,
        source,
        propertyId,
        claim: { id: id(offset + 4), rowStateSha256: "f".repeat(64) },
        connections: [{ id: id(offset + 5), rowStateSha256: "1".repeat(64) }],
      },
      property: { id: propertyId, rowStateSha256: "2".repeat(64) },
    };
  });
  return canonicalizeJson({
    version: "vay2017-historical-binding-preflight.v1",
    environment: "production",
    signingKeyId: "migration-production-2026-09",
    requests,
  });
}

const signature = (raw: string) =>
  sign(null, Buffer.from(`${domain}${raw}`), signingKeys.privateKey).toString("base64url");

beforeEach(() => vi.resetAllMocks());

describe("historical binding production preflight runner", () => {
  it("requires the pinned complete eight-pair production input", () => {
    expect(APPROVED_SOURCE_RUN_ID).toBe("vay1351-61ec013e79ed2a042caadef8");
    const raw = rawInput();
    expect(
      parseLegacyHistoricalBindingPreflightInput(raw, signature(raw), verificationKeys).requests,
    ).toHaveLength(8);
    expect(() =>
      parseLegacyHistoricalBindingPreflightInput(raw, "0".repeat(86), verificationKeys),
    ).toThrow("Invalid preflight signature");

    const liveSource = JSON.parse(raw);
    liveSource.requests[0].sourceRequest.sourceEnvironment = "production";
    const liveSourceRaw = canonicalizeJson(liveSource);
    expect(() =>
      parseLegacyHistoricalBindingPreflightInput(
        liveSourceRaw,
        signature(liveSourceRaw),
        verificationKeys,
      ),
    ).toThrow("Inconsistent preflight request");

    const duplicate = JSON.parse(raw);
    duplicate.requests[7] = duplicate.requests[0];
    const duplicateRaw = canonicalizeJson(duplicate);
    expect(() =>
      parseLegacyHistoricalBindingPreflightInput(
        duplicateRaw,
        signature(duplicateRaw),
        verificationKeys,
      ),
    ).toThrow("Duplicate preflight pair");

    const replacement = JSON.parse(raw);
    replacement.requests[7].sourceRequest.source.hotelId = id(98);
    replacement.requests[7].sourceRequest.source.externalPropertyId = id(99);
    replacement.requests[7].bindingExpected.source.hotelId = id(98);
    replacement.requests[7].bindingExpected.source.externalPropertyId = id(99);
    replacement.requests[7].bindingExpected.propertyId = id(98);
    replacement.requests[7].property.id = id(98);
    const replacementRaw = canonicalizeJson(replacement);
    expect(() =>
      parseLegacyHistoricalBindingPreflightInput(
        replacementRaw,
        signature(replacementRaw),
        verificationKeys,
      ),
    ).toThrow("approved eight pairs");

    const mixed = JSON.parse(raw);
    mixed.requests[7].sourceRequest.sourceEvidenceSha256 = "9".repeat(64);
    const mixedRaw = canonicalizeJson(mixed);
    expect(() =>
      parseLegacyHistoricalBindingPreflightInput(mixedRaw, signature(mixedRaw), verificationKeys),
    ).toThrow("Mixed preflight source boundaries");
  });

  it("returns only sanitized non-executable pair assessments", async () => {
    read
      .mockResolvedValue({
        outcome: "supplied_binding_matches_requires_owner_eligibility",
        executable: false,
        observations: {} as never,
      })
      .mockResolvedValueOnce({
        outcome: "blocked",
        reason: "source_inactive_requires_explicit_disposition",
        executable: false,
      });
    const raw = rawInput();
    const input = parseLegacyHistoricalBindingPreflightInput(raw, signature(raw), verificationKeys);
    const result = await runLegacyHistoricalBindingPreflight(
      { source: { connect: vi.fn() }, target: { connect: vi.fn() } },
      input,
    );

    expect(result).toMatchObject({ status: "blocked", executable: false });
    expect(result.results).toHaveLength(8);
    expect(result.results[0]).toMatchObject({
      outcome: "blocked",
      reason: "source_inactive_requires_explicit_disposition",
      executable: false,
    });
    expect(JSON.stringify(result)).not.toContain("observations");
    expect(read).toHaveBeenCalledTimes(8);

    read.mockResolvedValue({
      outcome: "supplied_binding_matches_requires_owner_eligibility",
      executable: false,
      observations: {} as never,
    });
    expect((await runLegacyHistoricalBindingPreflight({} as never, input)).status).toBe("assessed");
  });
});
