import { verify as verifyDetached, type KeyObject } from "node:crypto";

import {
  canonicalizeJson,
  ChannexAdoptionManifestError,
  hashApprovalSubject,
  hashManifestPayload,
} from "./channexAdoptionManifestCrypto.js";

export const CHANNEX_ADOPTION_CONTRACT_VERSION = "channex-property-adoption.v1";
export const CHANNEX_ADOPTION_SIGNATURE_ALGORITHM = "ed25519";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const SOURCE_RUN = /^vay1351-[0-9a-f]{24}$/;
const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const SIGNING_KEY = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

const ROOT_KEYS = [
  "contractVersion",
  "manifestId",
  "issuedAt",
  "expiresAt",
  "environment",
  "sourceEnvironment",
  "sourceRunId",
  "sourceSchemaRevision",
  "sourceEvidenceSha256",
  "legacyPmsHotelId",
  "externalPropertyId",
  "targetPropertyId",
  "targetOrganizationId",
  "targetSourceLinkId",
  "legacyResourceLinkId",
  "targetResourceLinkId",
  "targetPmsResourceLinkId",
  "legacyEvidence",
  "targetEvidence",
  "approvalSubjectSha256",
  "approvalEvidence",
  "signingKeyId",
] as const;

type RowEvidence = { rowOrdinal: number; rowChecksumSha256: string };
type AggregateEvidence = { rowCount: number; orderedRowsSha256: string };
type TargetRow = { id: string; rowStateSha256: string };
type ApprovalEvidence = {
  approvalRecordId: string;
  authority: "migration_owner" | "security_owner";
  actorUserId: string;
  approvedAt: string;
  approvalSubjectSha256: string;
  registryRevision: number;
  rowStateSha256: string;
};

export type ChannexAdoptionManifest = {
  contractVersion: typeof CHANNEX_ADOPTION_CONTRACT_VERSION;
  manifestId: string;
  issuedAt: string;
  expiresAt: string;
  environment: "local" | "staging" | "preprod" | "production";
  sourceEnvironment: "local" | "staging" | "preprod";
  sourceRunId: string;
  sourceSchemaRevision: string;
  sourceEvidenceSha256: string;
  legacyPmsHotelId: string;
  externalPropertyId: string;
  targetPropertyId: string;
  targetOrganizationId: string;
  targetSourceLinkId: string;
  legacyResourceLinkId: string;
  targetResourceLinkId: string;
  targetPmsResourceLinkId: string;
  legacyEvidence: {
    hotel: RowEvidence & { userId: string };
    connection: RowEvidence;
    roomTypeMappings: AggregateEvidence;
    ratePlanMappings: AggregateEvidence;
    bookingMappings: AggregateEvidence;
    bookings: AggregateEvidence;
  };
  targetEvidence: {
    property: TargetRow;
    sourceLink: TargetRow & {
      migrationRunId: string;
      migrationPhase: "complete";
      migrationDisposition: "canonical";
    };
    legacyResourceLink: TargetRow;
    targetResourceLink: TargetRow;
    targetPmsResourceLink: TargetRow;
    organization: TargetRow;
    bindingClaims: AggregateEvidence;
  };
  approvalSubjectSha256: string;
  approvalEvidence: [ApprovalEvidence, ApprovalEvidence];
  signingKeyId: string;
};

export type ParsedChannexAdoptionManifest = {
  manifest: ChannexAdoptionManifest;
  canonicalPayload: string;
  approvalSubjectSha256: string;
  payloadSha256: string;
};

function fail(code: string, path?: string): never {
  throw new ChannexAdoptionManifestError(code, path);
}
const exact = (value: unknown, keys: readonly string[], path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID_OBJECT", path);
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...keys].sort().join("\0")) return fail("INVALID_FIELDS", path);
  return value as Record<string, unknown>;
};
const string = (value: unknown, pattern: RegExp, path: string): string =>
  typeof value === "string" && pattern.test(value) ? value : fail("INVALID_VALUE", path);
const integer = (value: unknown, minimum: number, path: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fail("INVALID_INTEGER", path);
const timestamp = (value: unknown, path: string): string => {
  const result = string(value, TIMESTAMP, path);
  const parsed = new Date(result);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === result
    ? result
    : fail("INVALID_TIMESTAMP", path);
};
const oneOf = <T extends string>(value: unknown, values: readonly T[], path: string): T =>
  typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fail("INVALID_VALUE", path);

function validateRow(value: unknown, path: string, hotel = false): void {
  const row = exact(
    value,
    hotel ? ["rowOrdinal", "rowChecksumSha256", "userId"] : ["rowOrdinal", "rowChecksumSha256"],
    path,
  );
  integer(row["rowOrdinal"], 1, `${path}.rowOrdinal`);
  string(row["rowChecksumSha256"], SHA256, `${path}.rowChecksumSha256`);
  if (hotel) string(row["userId"], UUID, `${path}.userId`);
}
function validateAggregate(value: unknown, path: string): void {
  const row = exact(value, ["rowCount", "orderedRowsSha256"], path);
  integer(row["rowCount"], 0, `${path}.rowCount`);
  string(row["orderedRowsSha256"], SHA256, `${path}.orderedRowsSha256`);
}
function validateTargetRow(value: unknown, path: string, sourceLink = false): void {
  const keys = sourceLink
    ? ["id", "rowStateSha256", "migrationRunId", "migrationPhase", "migrationDisposition"]
    : ["id", "rowStateSha256"];
  const row = exact(value, keys, path);
  string(row["id"], UUID, `${path}.id`);
  string(row["rowStateSha256"], SHA256, `${path}.rowStateSha256`);
  if (sourceLink) {
    string(row["migrationRunId"], SOURCE_RUN, `${path}.migrationRunId`);
    if (row["migrationPhase"] !== "complete" || row["migrationDisposition"] !== "canonical")
      fail("INVALID_VALUE", path);
  }
}

function validateManifest(value: unknown): ChannexAdoptionManifest {
  const manifest = exact(value, ROOT_KEYS, "manifest");
  if (manifest["contractVersion"] !== CHANNEX_ADOPTION_CONTRACT_VERSION)
    fail("UNKNOWN_CONTRACT_VERSION", "manifest.contractVersion");
  string(manifest["manifestId"], UUID, "manifest.manifestId");
  const issuedAt = timestamp(manifest["issuedAt"], "manifest.issuedAt");
  const expiresAt = timestamp(manifest["expiresAt"], "manifest.expiresAt");
  if (issuedAt >= expiresAt) fail("INVALID_TIME_WINDOW", "manifest.expiresAt");
  oneOf(
    manifest["environment"],
    ["local", "staging", "preprod", "production"],
    "manifest.environment",
  );
  oneOf(
    manifest["sourceEnvironment"],
    ["local", "staging", "preprod"],
    "manifest.sourceEnvironment",
  );
  string(manifest["sourceRunId"], SOURCE_RUN, "manifest.sourceRunId");
  string(manifest["sourceSchemaRevision"], SOURCE_REVISION, "manifest.sourceSchemaRevision");
  string(manifest["sourceEvidenceSha256"], SHA256, "manifest.sourceEvidenceSha256");
  for (const key of [
    "legacyPmsHotelId",
    "externalPropertyId",
    "targetPropertyId",
    "targetOrganizationId",
    "targetSourceLinkId",
    "legacyResourceLinkId",
    "targetResourceLinkId",
    "targetPmsResourceLinkId",
  ])
    string(manifest[key], UUID, `manifest.${key}`);

  const legacy = exact(
    manifest["legacyEvidence"],
    ["hotel", "connection", "roomTypeMappings", "ratePlanMappings", "bookingMappings", "bookings"],
    "manifest.legacyEvidence",
  );
  validateRow(legacy["hotel"], "manifest.legacyEvidence.hotel", true);
  validateRow(legacy["connection"], "manifest.legacyEvidence.connection");
  for (const key of ["roomTypeMappings", "ratePlanMappings", "bookingMappings", "bookings"])
    validateAggregate(legacy[key], `manifest.legacyEvidence.${key}`);

  const target = exact(
    manifest["targetEvidence"],
    [
      "property",
      "sourceLink",
      "legacyResourceLink",
      "targetResourceLink",
      "targetPmsResourceLink",
      "organization",
      "bindingClaims",
    ],
    "manifest.targetEvidence",
  );
  for (const key of [
    "property",
    "legacyResourceLink",
    "targetResourceLink",
    "targetPmsResourceLink",
    "organization",
  ])
    validateTargetRow(target[key], `manifest.targetEvidence.${key}`);
  validateTargetRow(target["sourceLink"], "manifest.targetEvidence.sourceLink", true);
  validateAggregate(target["bindingClaims"], "manifest.targetEvidence.bindingClaims");
  const ids = [
    ["property", "targetPropertyId"],
    ["sourceLink", "targetSourceLinkId"],
    ["legacyResourceLink", "legacyResourceLinkId"],
    ["targetResourceLink", "targetResourceLinkId"],
    ["targetPmsResourceLink", "targetPmsResourceLinkId"],
    ["organization", "targetOrganizationId"],
  ] as const;
  for (const [row, top] of ids)
    if ((target[row] as Record<string, unknown>)["id"] !== manifest[top])
      fail("EVIDENCE_ID_MISMATCH", `manifest.targetEvidence.${row}.id`);
  if (
    (target["sourceLink"] as Record<string, unknown>)["migrationRunId"] !== manifest["sourceRunId"]
  )
    fail("EVIDENCE_ID_MISMATCH", "manifest.targetEvidence.sourceLink.migrationRunId");

  const subject = string(
    manifest["approvalSubjectSha256"],
    SHA256,
    "manifest.approvalSubjectSha256",
  );
  if (!Array.isArray(manifest["approvalEvidence"]) || manifest["approvalEvidence"].length !== 2)
    fail("INVALID_APPROVALS", "manifest.approvalEvidence");
  const approvals = manifest["approvalEvidence"] as unknown[];
  const actors = new Set<string>();
  const records = new Set<string>();
  for (const [index, expectedAuthority] of ["migration_owner", "security_owner"].entries()) {
    const path = `manifest.approvalEvidence.${index}`;
    const approval = exact(
      approvals[index],
      [
        "approvalRecordId",
        "authority",
        "actorUserId",
        "approvedAt",
        "approvalSubjectSha256",
        "registryRevision",
        "rowStateSha256",
      ],
      path,
    );
    records.add(string(approval["approvalRecordId"], UUID, `${path}.approvalRecordId`));
    if (approval["authority"] !== expectedAuthority)
      fail("INVALID_APPROVAL_ORDER", `${path}.authority`);
    actors.add(string(approval["actorUserId"], UUID, `${path}.actorUserId`));
    timestamp(approval["approvedAt"], `${path}.approvedAt`);
    if (approval["approvalSubjectSha256"] !== subject) fail("APPROVAL_SUBJECT_MISMATCH", path);
    integer(approval["registryRevision"], 1, `${path}.registryRevision`);
    string(approval["rowStateSha256"], SHA256, `${path}.rowStateSha256`);
  }
  if (actors.size !== 2) fail("APPROVER_COLLISION", "manifest.approvalEvidence");
  if (records.size !== 2) fail("APPROVAL_RECORD_COLLISION", "manifest.approvalEvidence");
  string(manifest["signingKeyId"], SIGNING_KEY, "manifest.signingKeyId");
  return manifest as ChannexAdoptionManifest;
}

function assertNoDuplicateKeys(raw: string): void {
  const stack: ({ keys: Set<string> } | null)[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === "{") stack.push({ keys: new Set() });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === '"') {
      const start = index;
      while (++index < raw.length && raw[index] !== '"') if (raw[index] === "\\") index += 1;
      if (index >= raw.length) fail("INVALID_JSON");
      let next = index + 1;
      while (/\s/.test(raw[next] ?? "")) next += 1;
      const object = stack.at(-1);
      if (object && raw[next] === ":") {
        let key: string;
        try {
          key = JSON.parse(raw.slice(start, index + 1)) as string;
        } catch {
          fail("INVALID_JSON");
        }
        if (object.keys.has(key)) fail("DUPLICATE_FIELD");
        object.keys.add(key);
      }
    }
  }
}

export function parseChannexAdoptionManifest(raw: string): ParsedChannexAdoptionManifest {
  assertNoDuplicateKeys(raw);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("INVALID_JSON");
  }
  const manifest = validateManifest(value);
  const approvalSubjectSha256 = hashApprovalSubject(manifest as unknown as Record<string, unknown>);
  if (manifest.approvalSubjectSha256 !== approvalSubjectSha256)
    fail("APPROVAL_SUBJECT_MISMATCH", "manifest.approvalSubjectSha256");
  const canonicalPayload = canonicalizeJson(manifest);
  return {
    manifest,
    canonicalPayload,
    approvalSubjectSha256,
    payloadSha256: hashManifestPayload(manifest),
  };
}

export function verifyChannexAdoptionManifest(input: {
  raw: string;
  detachedSignature: string;
  algorithm: string;
  verificationKeys: ReadonlyMap<string, KeyObject>;
}): ParsedChannexAdoptionManifest {
  if (input.algorithm !== CHANNEX_ADOPTION_SIGNATURE_ALGORITHM)
    fail("UNSUPPORTED_SIGNATURE_ALGORITHM");
  const parsed = parseChannexAdoptionManifest(input.raw);
  const key = input.verificationKeys.get(parsed.manifest.signingKeyId);
  if (!key) fail("UNKNOWN_SIGNING_KEY");
  if (key.type !== "public" || key.asymmetricKeyType !== CHANNEX_ADOPTION_SIGNATURE_ALGORITHM)
    fail("INVALID_VERIFICATION_KEY");
  const signature = Buffer.from(input.detachedSignature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== input.detachedSignature)
    fail("INVALID_SIGNATURE_ENCODING");
  if (!verifyDetached(null, Buffer.from(parsed.canonicalPayload, "utf8"), key, signature))
    fail("INVALID_SIGNATURE");
  return parsed;
}
