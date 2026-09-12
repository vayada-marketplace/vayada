import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseChannexAdoptionManifest,
  verifyChannexAdoptionManifest,
  type ChannexAdoptionManifest,
} from "./channexAdoptionManifest.js";
import { canonicalizeJson, hashApprovalSubject } from "./channexAdoptionManifestCrypto.js";

const HASH = "0".repeat(64);
const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

function fixture(): {
  manifest: ChannexAdoptionManifest;
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  const sourceRunId = `vay1351-${"a".repeat(24)}`;
  const manifest: ChannexAdoptionManifest = {
    contractVersion: "channex-property-adoption.v1",
    manifestId: uuid("1"),
    issuedAt: "2026-09-11T10:00:00.000Z",
    expiresAt: "2026-09-12T10:00:00.000Z",
    environment: "staging",
    sourceEnvironment: "staging",
    sourceRunId,
    sourceSchemaRevision: "b".repeat(40),
    sourceEvidenceSha256: HASH,
    legacyPmsHotelId: uuid("2"),
    externalPropertyId: uuid("3"),
    targetPropertyId: uuid("4"),
    targetOrganizationId: uuid("5"),
    targetSourceLinkId: uuid("6"),
    legacyResourceLinkId: uuid("7"),
    targetResourceLinkId: uuid("8"),
    targetPmsResourceLinkId: uuid("9"),
    legacyEvidence: {
      hotel: { rowOrdinal: 1, rowChecksumSha256: HASH, userId: uuid("10") },
      connection: { rowOrdinal: 2, rowChecksumSha256: HASH },
      roomTypeMappings: { rowCount: 0, orderedRowsSha256: HASH },
      ratePlanMappings: { rowCount: 0, orderedRowsSha256: HASH },
      bookingMappings: { rowCount: 0, orderedRowsSha256: HASH },
      bookings: { rowCount: 0, orderedRowsSha256: HASH },
    },
    targetEvidence: {
      property: { id: uuid("4"), rowStateSha256: HASH },
      sourceLink: {
        id: uuid("6"),
        rowStateSha256: HASH,
        migrationRunId: sourceRunId,
        migrationPhase: "complete",
        migrationDisposition: "canonical",
      },
      legacyResourceLink: { id: uuid("7"), rowStateSha256: HASH },
      targetResourceLink: { id: uuid("8"), rowStateSha256: HASH },
      targetPmsResourceLink: { id: uuid("9"), rowStateSha256: HASH },
      organization: { id: uuid("5"), rowStateSha256: HASH },
      bindingClaims: { rowCount: 0, orderedRowsSha256: HASH },
    },
    approvalSubjectSha256: HASH,
    approvalEvidence: [
      {
        approvalRecordId: uuid("11"),
        authority: "migration_owner",
        actorUserId: uuid("12"),
        approvedAt: "2026-09-11T10:01:00.000Z",
        approvalSubjectSha256: HASH,
        registryRevision: 1,
        rowStateSha256: HASH,
      },
      {
        approvalRecordId: uuid("13"),
        authority: "security_owner",
        actorUserId: uuid("14"),
        approvedAt: "2026-09-11T10:02:00.000Z",
        approvalSubjectSha256: HASH,
        registryRevision: 2,
        rowStateSha256: HASH,
      },
    ],
    signingKeyId: "migration-staging-2026-01",
  };
  const subject = hashApprovalSubject(manifest as unknown as Record<string, unknown>);
  manifest.approvalSubjectSha256 = subject;
  manifest.approvalEvidence.forEach((approval) => (approval.approvalSubjectSha256 = subject));
  return { manifest, ...generateKeyPairSync("ed25519") };
}

const signatureFor = (manifest: ChannexAdoptionManifest, privateKey: KeyObject) =>
  sign(null, Buffer.from(canonicalizeJson(manifest)), privateKey).toString("base64url");

const verifyFixture = (
  manifest: ChannexAdoptionManifest,
  privateKey: KeyObject,
  publicKey: KeyObject,
  raw = JSON.stringify(manifest),
) =>
  verifyChannexAdoptionManifest({
    raw,
    detachedSignature: signatureFor(manifest, privateKey),
    algorithm: "ed25519",
    verificationKeys: new Map([[manifest.signingKeyId, publicKey]]),
  });

describe("signed Channex adoption manifest", () => {
  it("parses and verifies the exact v1 contract independent of JSON formatting", () => {
    const { manifest, privateKey, publicKey } = fixture();
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    const parsed = verifyFixture(
      manifest,
      privateKey,
      publicKey,
      JSON.stringify(reordered, null, 2),
    );

    expect(parsed.approvalSubjectSha256).toBe(
      "b02c8fa4b86e39e4778e1aceda07378296ff1b1d468388198c9fcd0187508ddb",
    );
    expect(parsed.payloadSha256).toBe(
      "7d432cf4399419070e4a350c7ac5cfba39069404ce2c069ea343307262fa2b16",
    );
    expect(parsed.manifest).toEqual(manifest);
  });

  it("rejects duplicate and unknown fields before accepting a manifest", () => {
    const { manifest } = fixture();
    const raw = JSON.stringify(manifest);
    expect(() =>
      parseChannexAdoptionManifest(
        raw.replace('"manifestId":', '"\\u006d\\u0061nifestId":"ignored","manifestId":'),
      ),
    ).toThrowError(/DUPLICATE_FIELD/);
    expect(() =>
      parseChannexAdoptionManifest(JSON.stringify({ ...manifest, unexpected: true })),
    ).toThrowError(/INVALID_FIELDS/);
    expect(() =>
      parseChannexAdoptionManifest(
        JSON.stringify({
          ...manifest,
          legacyEvidence: { ...manifest.legacyEvidence, unexpected: true },
        }),
      ),
    ).toThrowError(/INVALID_FIELDS/);
  });

  it.each([
    [
      "uppercase UUID",
      (m: ChannexAdoptionManifest) => (m.manifestId = "00000000-0000-4000-8000-00000000000A"),
      "INVALID_VALUE",
    ],
    [
      "non-millisecond timestamp",
      (m: ChannexAdoptionManifest) => (m.issuedAt = "2026-09-11T10:00:00Z"),
      "INVALID_VALUE",
    ],
    [
      "invalid calendar timestamp",
      (m: ChannexAdoptionManifest) => (m.issuedAt = "2026-99-11T10:00:00.000Z"),
      "INVALID_TIMESTAMP",
    ],
    [
      "invalid time window",
      (m: ChannexAdoptionManifest) => (m.expiresAt = m.issuedAt),
      "INVALID_TIME_WINDOW",
    ],
    [
      "unknown contract version",
      (m: ChannexAdoptionManifest) =>
        (m.contractVersion = "channex-property-adoption.v2" as typeof m.contractVersion),
      "UNKNOWN_CONTRACT_VERSION",
    ],
    [
      "reversed approvals",
      (m: ChannexAdoptionManifest) => m.approvalEvidence.reverse(),
      "INVALID_APPROVAL_ORDER",
    ],
    [
      "same approver",
      (m: ChannexAdoptionManifest) =>
        (m.approvalEvidence[1].actorUserId = m.approvalEvidence[0].actorUserId),
      "APPROVER_COLLISION",
    ],
    [
      "same approval record",
      (m: ChannexAdoptionManifest) =>
        (m.approvalEvidence[1].approvalRecordId = m.approvalEvidence[0].approvalRecordId),
      "APPROVAL_RECORD_COLLISION",
    ],
    [
      "nested evidence mismatch",
      (m: ChannexAdoptionManifest) => (m.targetEvidence.property.id = uuid("99")),
      "EVIDENCE_ID_MISMATCH",
    ],
    [
      "approval subject drift",
      (m: ChannexAdoptionManifest) => (m.sourceEvidenceSha256 = "1".repeat(64)),
      "APPROVAL_SUBJECT_MISMATCH",
    ],
    [
      "unsafe aggregate count",
      (m: ChannexAdoptionManifest) =>
        (m.legacyEvidence.bookings.rowCount = Number.MAX_SAFE_INTEGER + 1),
      "INVALID_INTEGER",
    ],
    [
      "invalid signing key ID",
      (m: ChannexAdoptionManifest) => (m.signingKeyId = "Unversioned key"),
      "INVALID_VALUE",
    ],
  ])("rejects %s", (_name, mutate, code) => {
    const { manifest } = fixture();
    mutate(manifest);
    expect(() => parseChannexAdoptionManifest(JSON.stringify(manifest))).toThrowError(
      new RegExp(code),
    );
  });

  it("fails closed for algorithm, key, signature encoding, and signature mismatches", () => {
    const { manifest, privateKey, publicKey } = fixture();
    const raw = JSON.stringify(manifest);
    const detachedSignature = signatureFor(manifest, privateKey);
    const input = {
      raw,
      detachedSignature,
      algorithm: "ed25519",
      verificationKeys: new Map([[manifest.signingKeyId, publicKey]]),
    };
    expect(() => verifyChannexAdoptionManifest({ ...input, algorithm: "rsa" })).toThrowError(
      /UNSUPPORTED_SIGNATURE_ALGORITHM/,
    );
    expect(() =>
      verifyChannexAdoptionManifest({ ...input, verificationKeys: new Map() }),
    ).toThrowError(/UNKNOWN_SIGNING_KEY/);
    expect(() =>
      verifyChannexAdoptionManifest({
        ...input,
        verificationKeys: new Map([[manifest.signingKeyId, privateKey]]),
      }),
    ).toThrowError(/INVALID_VERIFICATION_KEY/);
    expect(() =>
      verifyChannexAdoptionManifest({ ...input, detachedSignature: "not-base64url" }),
    ).toThrowError(/INVALID_SIGNATURE_ENCODING/);
    const otherKey = generateKeyPairSync("ed25519").publicKey;
    expect(() =>
      verifyChannexAdoptionManifest({
        ...input,
        verificationKeys: new Map([[manifest.signingKeyId, otherKey]]),
      }),
    ).toThrowError(/INVALID_SIGNATURE/);

    const tampered = structuredClone(manifest);
    tampered.externalPropertyId = uuid("99");
    const subject = hashApprovalSubject(tampered as unknown as Record<string, unknown>);
    tampered.approvalSubjectSha256 = subject;
    tampered.approvalEvidence.forEach((approval) => (approval.approvalSubjectSha256 = subject));
    expect(() =>
      verifyChannexAdoptionManifest({ ...input, raw: JSON.stringify(tampered) }),
    ).toThrowError(/INVALID_SIGNATURE/);
  });
});
