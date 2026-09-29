import { verify, type KeyObject } from "node:crypto";
import type pg from "pg";

import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  readLegacyHistoricalBindingEvidenceSnapshot,
  type LegacyHistoricalBindingEvidenceRequest,
} from "./legacyHistoricalBindingEvidenceSnapshot.js";

const VERSION = "vay2017-historical-binding-preflight.v1";
const DOMAIN = "vayada:vay2017-historical-binding-preflight:v1\0";
const APPROVED_SOURCE_RUN_ID = "vay1351-b68e50b476c7a997f8ac4703";
const APPROVED_PAIRS = new Set([
  "29f39aae-4ea8-4730-948a-c36780347750|237e8ee7-3a88-474e-97b6-80fc953026e2",
  "26e9e98f-1f64-483f-8cb5-a5fa7499ba5d|253dc0ba-6518-4117-86e4-b3d0da05b13d",
  "8f5919ed-4fc5-4d64-a65c-07486ec3f651|50e2edff-0399-4171-8e3e-ac04ffd3df24",
  "c8efd685-527c-43da-a2f4-07e1b820b31e|61937e72-4e7f-4028-82d2-00c33433b607",
  "7d3f6dcc-37f0-4446-bad8-7335819c180a|aeab85ad-8193-4c3e-9a65-491d05391720",
  "6aca326e-9fb7-4139-a43c-d495c397700a|cfcddb9b-9607-4f5e-8759-23111bb68ab7",
  "6810de91-f389-47ab-8f92-68abb2d8b163|e13f3645-d50b-4788-bb04-9e68ece0d647",
  "b8efb175-7a94-49d5-98f9-1a6c28f6ec17|fc18d06d-c752-4621-bc3f-65b17d682b18",
]);

export type LegacyHistoricalBindingPreflightInput = {
  version: typeof VERSION;
  environment: "production";
  signingKeyId: string;
  requests: LegacyHistoricalBindingEvidenceRequest[];
};

export function parseLegacyHistoricalBindingPreflightInput(
  raw: string,
  detachedSignature: string,
  verificationKeys: ReadonlyMap<string, KeyObject>,
): LegacyHistoricalBindingPreflightInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Preflight input is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid preflight input");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join("\0") !== "environment\0requests\0signingKeyId\0version" ||
    input.version !== VERSION ||
    input.environment !== "production" ||
    typeof input.signingKeyId !== "string" ||
    !Array.isArray(input.requests) ||
    input.requests.length !== 8
  )
    throw new Error("Invalid preflight input");
  if (canonicalizeJson(input) !== raw) throw new Error("Preflight input must be canonical JSON");
  const key = verificationKeys.get(input.signingKeyId);
  const signature = Buffer.from(detachedSignature, "base64url");
  if (
    !key ||
    key.type !== "public" ||
    key.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64 ||
    signature.toString("base64url") !== detachedSignature ||
    !verify(null, Buffer.from(`${DOMAIN}${raw}`), key, signature)
  )
    throw new Error("Invalid preflight signature");

  const requests = input.requests as LegacyHistoricalBindingEvidenceRequest[];
  const keys = new Set<string>();
  const sourceBoundaries = new Set<string>();
  for (const request of requests) {
    const source = request?.sourceRequest;
    const binding = request?.bindingExpected;
    if (
      source?.sourceEnvironment !== "production" ||
      source.sourceRunId !== APPROVED_SOURCE_RUN_ID ||
      source.sourceRunId !== binding?.sourceRunId ||
      source.source?.externalPropertyId !== binding?.source?.externalPropertyId ||
      request.property?.id !== binding?.propertyId
    )
      throw new Error("Inconsistent preflight request");
    keys.add(`${binding.propertyId}|${binding.source.externalPropertyId}`);
    sourceBoundaries.add(
      [
        source.sourceRunId,
        source.sourceEnvironment,
        source.sourceSchemaRevision,
        source.sourceEvidenceSha256,
        source.snapshotIdentifierSha256,
      ].join("\0"),
    );
  }
  if (keys.size !== requests.length) throw new Error("Duplicate preflight pair");
  if (keys.size !== APPROVED_PAIRS.size || [...keys].some((key) => !APPROVED_PAIRS.has(key)))
    throw new Error("Preflight cohort does not match the approved eight pairs");
  if (sourceBoundaries.size !== 1) throw new Error("Mixed preflight source boundaries");

  return structuredClone(input) as LegacyHistoricalBindingPreflightInput;
}

export async function runLegacyHistoricalBindingPreflight(
  pools: { source: Pick<pg.Pool, "connect">; target: Pick<pg.Pool, "connect"> },
  input: LegacyHistoricalBindingPreflightInput,
) {
  const results = [];
  for (const request of input.requests) {
    const result = await readLegacyHistoricalBindingEvidenceSnapshot(pools, request);
    results.push(
      Object.freeze({
        propertyId: request.bindingExpected.propertyId,
        externalPropertyId: request.bindingExpected.source.externalPropertyId,
        outcome: result.outcome,
        reason: "reason" in result ? result.reason : null,
        executable: false as const,
      }),
    );
  }
  return Object.freeze({
    version: input.version,
    environment: input.environment,
    status: results.every(
      (result) => result.outcome === "supplied_binding_matches_requires_owner_eligibility",
    )
      ? "assessed"
      : "blocked",
    executable: false as const,
    results: Object.freeze(results),
  });
}
