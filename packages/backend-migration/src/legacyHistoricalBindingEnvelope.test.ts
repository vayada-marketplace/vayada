import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";
import {
  hashLegacyHistoricalBindingApprovalEvidence as hash,
  verifyLegacyHistoricalBindingEnvelope as verify,
  type LegacyHistoricalBindingApprovalEvidence,
  type LegacyHistoricalBindingEnvelope,
} from "./legacyHistoricalBindingEnvelope.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const domain = "vayada:legacy-historical-binding-transition:v1\0envelope\0";
function fixture() {
  const source = {
    id: id(20),
    hotelId: id(10),
    externalPropertyId: id(21),
    rowOrdinal: 1,
    rowChecksumSha256: sha,
  };
  const sourceRunId = `vay1351-${"a".repeat(24)}`;
  const target = Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).map(([kind, table], i) => ({
    kind,
    table,
    id: id(i + 1),
    rowStateSha256: sha,
  })) as LegacyOwnershipFingerprint[];
  const sourceProof = {
    sourceRunId,
    sourceEnvironment: "local" as const,
    sourceSchemaRevision: "b".repeat(40),
    sourceEvidenceSha256: sha,
  };
  const evidence: LegacyHistoricalBindingApprovalEvidence = {
    owner: {
      source: {
        ...sourceProof,
        legacyHotelId: id(10),
        ownerUserId: id(1),
        hotelRowOrdinal: 1,
        userRowOrdinal: 1,
      },
      target,
      identity: {
        userId: id(1),
        organizationId: id(3),
        externalIdentityId: id(11),
        externalIdentitySha256: sha,
        workosUserId: "user_fixture",
        workosOrgId: "org_fixture",
      },
    },
    binding: {
      sourceRequest: { ...sourceProof, snapshotIdentifierSha256: sha, source },
      bindingExpected: {
        sourceRunId,
        source,
        propertyId: id(4),
        claim: { id: id(22), rowStateSha256: sha },
        connections: [{ id: id(23), rowStateSha256: sha }],
      },
      property: { id: id(4), rowStateSha256: sha },
    },
    sourceActive: true,
    targetBeforeSha256: sha,
    targetAfterSha256: "b".repeat(64),
  };
  const envelope: LegacyHistoricalBindingEnvelope = {
    contractVersion: "legacy-historical-binding-transition.v1",
    commandId: id(30),
    environment: "local",
    purpose: "prepare",
    originalPrepareCommandId: null,
    issuedAt: "2026-09-15T01:00:00.000Z",
    expiresAt: "2026-09-15T02:00:00.000Z",
    evidenceSha256: hash(evidence),
    migrationApprovalRecordId: id(31),
    securityApprovalRecordId: id(32),
    signingKeyId: "synthetic",
  };
  const signed = (value: unknown = envelope, separator = domain) => {
    const canonicalPayload = canonicalizeJson(value);
    return {
      canonicalPayload,
      detachedSignature: sign(
        null,
        Buffer.from(separator + canonicalPayload),
        keys.privateKey,
      ).toString("base64url"),
    };
  };
  const input = () => ({
    ...signed(),
    evidence,
    environment: "local" as const,
    verificationKeys: new Map([["synthetic", keys.publicKey]]),
    now: new Date("2026-09-15T01:30:00.000Z"),
  });
  return { evidence, envelope, signed, input };
}
describe("historical binding signed envelope (synthetic keys only)", () => {
  it.each(["prepare", "compensate"] as const)("binds %s without granting authority", (purpose) => {
    const f = fixture();
    f.envelope.purpose = purpose;
    f.envelope.originalPrepareCommandId = purpose === "compensate" ? id(29) : null;
    const result = verify(f.input());
    expect(result).toEqual({
      outcome: "signature_matches_requires_registry_and_locked_eligibility",
      envelope: f.envelope,
    });
    expect(Object.isFrozen(result.envelope)).toBe(true);
  });
  it.each([
    ["purpose", "activate"],
    ["originalPrepareCommandId", id(29)],
    ["commandId", "invalid"],
    ["securityApprovalRecordId", id(31)],
    ["environment", "production"],
    ["contractVersion", "legacy-pms-owner-evidence.v1"],
    ["expiresAt", "2026-09-15T01:30:00.000Z"],
    ["issuedAt", "2026-09-15T01:31:00.000Z"],
    ["issuedAt", "2026-09-15T01:00:00Z"],
  ])("rejects signed invalid %s", (field, value) => {
    const f = fixture();
    expect(() =>
      verify({ ...f.input(), ...f.signed({ ...f.envelope, [field!]: value }) }),
    ).toThrow();
  });
  it.each([null, id(30), "invalid"])(
    "rejects invalid compensation identity %s",
    (originalPrepareCommandId) => {
      const f = fixture();
      expect(() =>
        verify({
          ...f.input(),
          ...f.signed({ ...f.envelope, purpose: "compensate", originalPrepareCommandId }),
        }),
      ).toThrow("invalid_purpose");
    },
  );
  it.each(["owner", "binding", "before", "after"])("rejects changed %s evidence", (field) => {
    const f = fixture();
    const input = f.input();
    if (field === "owner") f.evidence.owner.identity.workosUserId = "user_other";
    if (field === "binding")
      f.evidence.binding.bindingExpected.claim.rowStateSha256 = "b".repeat(64);
    if (field === "before") f.evidence.targetBeforeSha256 = "b".repeat(64);
    if (field === "after") f.evidence.targetAfterSha256 = sha;
    expect(() => verify(input)).toThrow("evidence_mismatch");
  });
  it.each(["inactive", "owner", "property", "source", "fingerprint"])(
    "rejects signed inconsistent %s",
    (field) => {
      const f = fixture();
      if (field === "inactive") Object.assign(f.evidence, { sourceActive: false });
      if (field === "owner") f.evidence.owner.identity.userId = id(99);
      if (field === "property") f.evidence.binding.property.id = id(99);
      if (field === "source")
        f.evidence.binding.sourceRequest.sourceRunId = `vay1351-${"b".repeat(24)}`;
      if (field === "fingerprint") f.evidence.targetBeforeSha256 = "bad";
      f.envelope.evidenceSha256 = hash(f.evidence);
      expect(() => verify(f.input())).toThrow();
    },
  );
  it.each([
    "17621565-40b5-4ebc-8727-3a301ac947a2",
    "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
    "65f6b2fc-c783-4963-9d6b-a85f82319769",
    "8f4c1e47-3de1-4150-8bde-ad031a013842",
  ])("rejects signed protected key %s", (key) => {
    const f = fixture();
    f.evidence.binding.bindingExpected.source.externalPropertyId = key;
    f.envelope.evidenceSha256 = hash(f.evidence);
    expect(() => verify(f.input())).toThrow("protected_fixture");
  });
  it.each([
    "extra",
    "whitespace",
    "duplicate",
    "unknown key",
    "private key",
    "signature",
    "owner domain",
    "clock",
  ])("rejects %s", (mode) => {
    const f = fixture();
    const input = f.input();
    if (mode === "extra") Object.assign(input, f.signed({ ...f.envelope, activate: true }));
    if (mode === "whitespace") input.canonicalPayload += "\n";
    if (mode === "duplicate")
      input.canonicalPayload = input.canonicalPayload.replace("{", `{"purpose":"prepare",`);
    if (mode === "unknown key") input.verificationKeys.clear();
    if (mode === "private key") input.verificationKeys.set("synthetic", keys.privateKey);
    if (mode === "signature") input.detachedSignature += "=";
    if (mode === "owner domain")
      Object.assign(input, f.signed(f.envelope, "vayada:legacy-pms-owner-evidence:v1\0envelope\0"));
    if (mode === "clock") input.now = new Date(NaN);
    expect(() => verify(input)).toThrow();
  });
  it("rejects a valid-shaped unsigned purpose change", () => {
    const f = fixture();
    const input = f.input();
    input.canonicalPayload = canonicalizeJson({
      ...f.envelope,
      purpose: "compensate",
      originalPrepareCommandId: id(29),
    });
    expect(() => verify(input)).toThrow("invalid_signature");
  });
});
