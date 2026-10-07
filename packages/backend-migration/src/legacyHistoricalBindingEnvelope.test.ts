import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  buildHistoricalBindingWriteIntent as build,
  hashHistoricalBindingTargetState as targetHash,
  type HistoricalBindingWriteEvidence,
} from "./legacyHistoricalBindingWriteIntent.js";
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

describe("signed historical prepare write intent (no database authority)", () => {
  function writeFixture() {
    const f = fixture();
    const evidence: HistoricalBindingWriteEvidence = {
      ...f.evidence,
      write: {
        claimCreatedAt: "2026-09-14T01:00:00.123456Z",
        claimUpdatedAt: "2026-09-15T01:29:00.654321Z",
        claimAfterSha256: "c".repeat(64),
      },
    };
    evidence.targetBeforeSha256 = targetHash(
      evidence,
      evidence.binding.bindingExpected.claim.rowStateSha256,
    );
    evidence.targetAfterSha256 = targetHash(evidence, evidence.write.claimAfterSha256);
    const input = () => {
      f.envelope.evidenceSha256 = hash(evidence);
      return { ...f.input(), evidence };
    };
    return { ...f, evidence, input };
  }
  it("derives the whole storage event and exact claim hashes without granting execution", () => {
    const f = writeFixture();
    const result = build(f.input(), "controlled-executor");
    expect(result.executable).toBe(false);
    expect(result.storageInput).toEqual({
      claimBeforeSha256: sha,
      claimAfterSha256: "c".repeat(64),
      updatedAt: f.evidence.write.claimUpdatedAt,
      event: {
        command_id: id(30),
        contract_version: f.envelope.contractVersion,
        environment: "local",
        event_kind: "prepare",
        compensates_command_id: null,
        claim_id: id(22),
        property_id: id(4),
        external_property_id: id(21),
        provider: "channex",
        claim_source: "migration",
        claim_created_at: f.evidence.write.claimCreatedAt,
        source_run_id: f.evidence.owner.source.sourceRunId,
        source_active: true,
        source_evidence_sha256: sha,
        payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        target_before_sha256: f.evidence.targetBeforeSha256,
        target_after_sha256: f.evidence.targetAfterSha256,
        approval_envelope_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        executor_principal_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        before_state: "historical",
        after_state: "verified_non_active",
      },
    });
    expect(build(f.input(), "controlled-executor")).toEqual(result);
    expect(
      build(f.input(), "other-executor").storageInput.event.executor_principal_sha256,
    ).not.toBe(result.storageInput.event.executor_principal_sha256);
    f.evidence.write.claimUpdatedAt = "2026-09-15T01:28:00.000000Z";
    expect(result.storageInput.updatedAt).toBe("2026-09-15T01:29:00.654321Z");
  });
  it.each(["claimCreatedAt", "claimUpdatedAt", "claimAfterSha256"] as const)(
    "rejects unsigned %s substitution",
    (field) => {
      const f = writeFixture(),
        input = f.input();
      f.evidence.write[field] =
        field === "claimAfterSha256" ? "d".repeat(64) : "2026-09-15T01:20:00.000000Z";
      expect(() => build(input, "executor")).toThrow("evidence_mismatch");
    },
  );
  it.each(["before", "after", "connection", "owner", "identity"])(
    "rejects signed aggregate mismatch for %s",
    (mode) => {
      const f = writeFixture();
      if (mode === "before") f.evidence.targetBeforeSha256 = sha;
      if (mode === "after") f.evidence.targetAfterSha256 = sha;
      if (mode === "connection")
        f.evidence.binding.bindingExpected.connections[0]!.rowStateSha256 = "d".repeat(64);
      if (mode === "owner") f.evidence.owner.target[0]!.rowStateSha256 = "d".repeat(64);
      if (mode === "identity") f.evidence.owner.identity.externalIdentitySha256 = "d".repeat(64);
      expect(() => build(f.input(), "executor")).toThrow("WRITE_INTENT_INVALID");
    },
  );
  it.each([
    "missing",
    "extra",
    "future",
    "invalid date",
    "noncanonical",
    "backdated",
    "unchanged",
    "compensate",
    "executor",
  ])("rejects signed invalid write intent: %s", (mode) => {
    const f = writeFixture();
    if (mode === "missing") Reflect.deleteProperty(f.evidence, "write");
    if (mode === "extra") Object.assign(f.evidence.write, { activate: true });
    if (mode === "future") f.evidence.write.claimUpdatedAt = "2026-09-15T01:30:00.000001Z";
    if (mode === "invalid date") f.evidence.write.claimUpdatedAt = "2026-02-30T01:00:00.000000Z";
    if (mode === "noncanonical") f.evidence.write.claimUpdatedAt = "2026-09-15T01:20:00Z";
    if (mode === "backdated") f.evidence.write.claimUpdatedAt = "2026-09-13T01:00:00.000000Z";
    if (mode === "unchanged") f.evidence.write.claimAfterSha256 = sha;
    if (mode === "compensate") {
      f.envelope.purpose = "compensate";
      f.envelope.originalPrepareCommandId = id(29);
    }
    expect(() => build(f.input(), mode === "executor" ? " " : "executor")).toThrow(
      "WRITE_INTENT_INVALID",
    );
  });
  it("canonicalizes set order and includes every target fingerprint", () => {
    const f = writeFixture(),
      before = f.evidence.targetBeforeSha256;
    f.evidence.owner.target = [...f.evidence.owner.target].reverse();
    expect(targetHash(f.evidence, sha)).toBe(before);
    for (const row of f.evidence.owner.target) {
      const changed = structuredClone(f.evidence);
      changed.owner.target.find((r) => r.kind === row.kind)!.rowStateSha256 = "d".repeat(64);
      expect(targetHash(changed, sha)).not.toBe(before);
    }
    expect(targetHash(f.evidence, "c".repeat(64))).toBe(f.evidence.targetAfterSha256);
  });
  it.each(["signature", "expired", "environment"])("rejects %s before producing input", (mode) => {
    const f = writeFixture(),
      input = f.input();
    if (mode === "signature") input.detachedSignature = "A".repeat(86);
    if (mode === "expired") input.now = new Date(f.envelope.expiresAt);
    if (mode === "environment") Object.assign(input, { environment: "production" });
    expect(() => build(input, "executor")).toThrow();
  });
});
