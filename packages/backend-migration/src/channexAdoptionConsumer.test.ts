import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeSignedChannexAdoptionManifest } from "./channexAdoptionConsumer.js";
import { rollbackChannexAdoption } from "./channexAdoptionRollback.js";
import * as manifestModule from "./channexAdoptionManifest.js";
import type { ParsedChannexAdoptionManifest } from "./channexAdoptionManifest.js";

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const payloadSha256 = "a".repeat(64);

function parsedManifest(): ParsedChannexAdoptionManifest {
  return {
    canonicalPayload: "{}",
    approvalSubjectSha256: "b".repeat(64),
    payloadSha256,
    manifest: {
      manifestId: uuid("1"),
      environment: "staging",
      sourceEnvironment: "staging",
      issuedAt: "2026-09-11T10:00:00.000Z",
      expiresAt: "2026-09-13T10:00:00.000Z",
      targetPropertyId: uuid("2"),
      externalPropertyId: uuid("3"),
      contractVersion: "channex-adoption-manifest.v1",
      sourceRunId: "source-run",
      sourceSchemaRevision: "source-revision",
      sourceEvidenceSha256: "c".repeat(64),
      signingKeyId: "signing-key",
      legacyPmsHotelId: uuid("6"),
      targetOrganizationId: uuid("7"),
      approvalEvidence: [
        { approvalRecordId: uuid("4"), actorUserId: uuid("8") },
        { approvalRecordId: uuid("5"), actorUserId: uuid("9") },
      ],
      legacyEvidence: {
        hotel: { rowOrdinal: 1, rowChecksumSha256: "d".repeat(64) },
        connection: {},
        roomTypeMappings: [],
        ratePlanMappings: [],
        bookingMappings: [],
        bookings: [],
      },
      targetEvidence: { bindingClaims: [] },
    } as never,
  };
}

const config = {
  environment: "staging" as const,
  executionPrincipal: "iam:migration-runner",
  allowedExecutionPrincipals: new Set(["iam:migration-runner"]),
  verificationKeys: new Map(),
  signingPrincipals: new Map(),
  approvalPrincipals: new Map(),
  singleHumanDualAuthority: null,
  now: () => new Date("2026-09-12T10:00:00.000Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("Channex adoption consumer boundary", () => {
  it("rejects a non-allowlisted execution principal before parsing or database access", async () => {
    const connect = vi.fn();
    await expect(
      consumeSignedChannexAdoptionManifest(
        { connect } as never,
        { raw: "not-json", detachedSignature: "not-a-signature" },
        {
          environment: "production",
          executionPrincipal: "iam:ordinary-runtime",
          allowedExecutionPrincipals: new Set(["iam:migration-runner"]),
          verificationKeys: new Map(),
          signingPrincipals: new Map(),
          approvalPrincipals: new Map(),
          singleHumanDualAuthority: null,
        },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_PRINCIPAL_FORBIDDEN" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rolls back transient verification failures without storing a terminal rejection", async () => {
    vi.spyOn(manifestModule, "verifyChannexAdoptionManifest").mockReturnValue(parsedManifest());
    const transient = Object.assign(new Error("serialization failure"), { code: "40001" });
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (text.includes("channex_adoption_manifest_consumptions")) return { rows: [] };
      if (text.includes("channex_adoption_approval_records")) throw transient;
      return { rows: [] };
    });
    const release = vi.fn();

    await expect(
      consumeSignedChannexAdoptionManifest(
        { connect: async () => ({ query, release }) } as never,
        { raw: "{}", detachedSignature: "signature" },
        config,
      ),
    ).rejects.toBe(transient);

    const statements = query.mock.calls.map(([text]) => text);
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((text) => text.includes("INSERT INTO"))).toBe(false);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it.each(["unlock", "release"] as const)(
    "preserves a consumption rejection when %s cleanup also fails",
    async (failurePoint) => {
      vi.spyOn(manifestModule, "verifyChannexAdoptionManifest").mockReturnValue(parsedManifest());
      const cleanupFailure = new Error(`${failurePoint} failed`);
      const query = vi.fn(async (text: string) => {
        if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (text.includes("channex_adoption_manifest_consumptions"))
          return {
            rows: [{ payloadSha256: "c".repeat(64), outcome: "succeeded", claimId: uuid("6") }],
          };
        if (failurePoint === "unlock" && text.includes("pg_advisory_unlock")) throw cleanupFailure;
        return { rows: [] };
      });
      const release = vi.fn(() => {
        if (failurePoint === "release") throw cleanupFailure;
      });

      let caught: unknown;
      try {
        await consumeSignedChannexAdoptionManifest(
          { connect: async () => ({ query, release }) } as never,
          { raw: "{}", detachedSignature: "signature" },
          config,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "MANIFEST_PAYLOAD_DRIFT" });
      expect(caught).not.toBe(cleanupFailure);
      expect(release).toHaveBeenCalledWith(failurePoint === "unlock" ? cleanupFailure : undefined);
    },
  );

  it("preserves a rollback rejection when advisory unlock also fails", async () => {
    const cleanupFailure = new Error("unlock failed");
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_advisory_unlock")) throw cleanupFailure;
      return { rows: [] };
    });
    const release = vi.fn();

    let caught: unknown;
    try {
      await rollbackChannexAdoption(
        { connect: async () => ({ query, release }) } as never,
        {
          manifestId: uuid("1"),
          reason: "test rollback",
          expiresAt: "2026-09-13T10:00:00.000Z",
          approvalRecordIds: [uuid("4"), uuid("5")],
        },
        config,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "ROLLBACK_MANIFEST_MISMATCH" });
    expect(caught).not.toBe(cleanupFailure);
    expect(release).toHaveBeenCalledWith(cleanupFailure);
  });

  it.each([
    ["manifest", 0],
    ["first binding", 1],
    ["second binding", 2],
  ] as const)(
    "fails a %s lock timeout as retryable without storing evidence",
    async (_, successes) => {
      vi.spyOn(manifestModule, "verifyChannexAdoptionManifest").mockReturnValue(parsedManifest());
      const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), {
        code: "55P03",
      });
      let lockAttempts = 0;
      const query = vi.fn(async (text: string) => {
        if (text.includes("pg_advisory_lock")) {
          if (lockAttempts++ === successes) throw lockTimeout;
          return { rows: [] };
        }
        if (text.includes("channex_adoption_manifest_consumptions")) return { rows: [] };
        return { rows: [] };
      });
      const release = vi.fn();

      await expect(
        consumeSignedChannexAdoptionManifest(
          { connect: async () => ({ query, release }) } as never,
          { raw: "{}", detachedSignature: "signature" },
          config,
        ),
      ).rejects.toBe(lockTimeout);

      const statements = query.mock.calls.map(([text]) => text);
      expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
      expect(statements.some((text) => text === "BEGIN ISOLATION LEVEL SERIALIZABLE")).toBe(false);
      expect(statements.some((text) => text.includes("INSERT INTO"))).toBe(false);
      expect(lockAttempts).toBe(successes + 1);
      expect(release).toHaveBeenCalledWith(undefined);
    },
  );

  it("keeps approval actor IDs only in the private audit payload", async () => {
    vi.spyOn(manifestModule, "verifyChannexAdoptionManifest").mockReturnValue(parsedManifest());
    const query = vi.fn(async (text: string, _parameters?: unknown[]) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (text.includes("channex_adoption_manifest_consumptions")) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      consumeSignedChannexAdoptionManifest(
        { connect: async () => ({ query, release: vi.fn() }) } as never,
        { raw: "{}", detachedSignature: "signature" },
        config,
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_EVIDENCE_MISMATCH" });

    const auditCall = query.mock.calls.find(([text]) =>
      text.includes("INSERT INTO platform.product_audit_events"),
    );
    expect(auditCall).toBeDefined();
    const parameters = auditCall![1] as string[];
    const redacted = JSON.parse(parameters[5]!) as Record<string, unknown>;
    const privatePayload = JSON.parse(parameters[6]!) as Record<string, unknown>;
    expect(redacted).not.toHaveProperty("approvalActorUserIds");
    expect(privatePayload).toEqual({
      approvalActorUserIds: [uuid("8"), uuid("9")],
    });
  });
});
