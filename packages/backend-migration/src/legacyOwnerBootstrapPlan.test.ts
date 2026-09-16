import { describe, expect, it } from "vitest";
import {
  planLegacyOwnerBootstrap,
  type OwnerBootstrapEvidence,
} from "./legacyOwnerBootstrapPlan.js";

const ids = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
const expected = {
  ownerIds: ids,
  sourceRunId: `vay1351-${"a".repeat(24)}`,
  targetEnvironment: "production",
};
const now = new Date("2026-09-14T03:00:00.000Z");
function evidence(): OwnerBootstrapEvidence {
  return {
    sourceRunId: expected.sourceRunId,
    targetEnvironment: "production",
    observedAt: "2026-09-14T02:59:00.000Z",
    expiresAt: "2026-09-14T03:05:00.000Z",
    complete: true,
    owners: ids.map((ownerId) => ({
      ownerId,
      sourceStatus: "pending",
      sourceOwnership: "matched",
      target: "absent",
      providerExternalId: "absent",
      providerEmail: "absent",
    })),
  };
}
const plan = (input = evidence()) => planLegacyOwnerBootstrap(expected, input, now);

describe("non-executable eight-owner bootstrap diagnostics", () => {
  it("proposes preparation for eight absent identities without mutating input", () => {
    const input = evidence(),
      before = structuredClone(input),
      result = plan(input);
    expect(result.outcome).toBe("proposed");
    expect(result.executable).toBe(false);
    expect(result.owners).toHaveLength(8);
    expect(result.owners.every((row) => row.nextStep === "prepare_missing_identity")).toBe(true);
    expect(input).toEqual(before);
  });
  it("accepts both eligible raw legacy source statuses", () => {
    const input = evidence();
    input.owners[0]!.sourceStatus = "verified";
    expect(plan(input).outcome).toBe("proposed");
    expect(plan(input).owners.every((row) => row.outcome === "proposed")).toBe(true);
  });
  it("distinguishes provider preparation from verified-session prerequisites", () => {
    const input = evidence();
    input.owners[0]!.target = "exact";
    input.owners[1]!.target = "exact";
    input.owners[1]!.providerExternalId = "exact";
    input.owners[1]!.providerEmail = "same_identity";
    expect(
      plan(input)
        .owners.slice(0, 2)
        .map((row) => row.nextStep),
    ).toEqual(["prepare_provider_identity", "verify_existing_identity"]);
  });
  it.each(["active", "accepted", "suspended", "rejected", "deleted", "retired", "unknown", ""])(
    "blocks source status %s",
    (status) => {
      const input = evidence();
      input.owners[0]!.sourceStatus = status;
      expect(plan(input).owners[0]!.reason).toBe("source_restricted_or_unknown");
      expect(plan(input).outcome).toBe("blocked");
      expect(plan(input).owners.filter((row) => row.outcome === "proposed")).toHaveLength(7);
    },
  );
  it.each(["missing", "conflict"] as const)("blocks %s ownership", (value) => {
    const input = evidence();
    input.owners[0]!.sourceOwnership = value;
    expect(plan(input).owners[0]!.outcome).toBe("blocked");
  });
  it.each(["restricted", "conflict", "unknown"] as const)("blocks %s target", (value) => {
    const input = evidence();
    input.owners[0]!.target = value;
    expect(plan(input).owners[0]!.outcome).toBe("blocked");
  });
  it.each(["conflict", "unknown"] as const)("blocks %s provider observations", (value) => {
    for (const field of ["providerExternalId", "providerEmail"] as const) {
      const input = evidence();
      input.owners[0]![field] = value;
      expect(plan(input).owners[0]!.outcome).toBe("blocked");
    }
  });
  it("does not link an email candidate or a provider-only identity", () => {
    for (const field of ["providerEmail", "providerExternalId"] as const) {
      const input = evidence();
      if (field === "providerEmail") input.owners[0]!.providerEmail = "same_identity";
      else input.owners[0]!.providerExternalId = "exact";
      expect(plan(input).owners[0]!.reason).toBe("identity_reconciliation_required");
    }
  });
  it.each(["missing", "extra", "duplicate", "unapproved", "incomplete"])(
    "rejects %s cohort",
    (mode) => {
      const input = evidence();
      if (mode === "missing") input.owners.pop();
      if (mode === "extra") input.owners.push({ ...input.owners[0]! });
      if (mode === "duplicate") input.owners[1] = { ...input.owners[0]! };
      if (mode === "unapproved") input.owners[0]!.ownerId = "00000000-0000-4000-8000-000000000099";
      if (mode === "incomplete") input.complete = false;
      expect(plan(input)).toMatchObject({ outcome: "blocked", owners: [], executable: false });
    },
  );
  it.each([
    "2026-09-14T03:00:00.000Z",
    "2026-09-14T04:00:00.000Z",
    "invalid",
    "2026-02-30T03:01:00.000Z",
  ])("rejects invalid expiry %s", (expiresAt) => {
    expect(plan({ ...evidence(), expiresAt }).reason).toBe("stale_or_invalid_evidence");
  });
  it("rejects future observations, invalid clocks and wrong run/environment", () => {
    expect(plan({ ...evidence(), observedAt: "2026-09-14T03:01:00.000Z" }).outcome).toBe("blocked");
    expect(planLegacyOwnerBootstrap(expected, evidence(), new Date(NaN)).outcome).toBe("blocked");
    expect(plan({ ...evidence(), sourceRunId: `vay1351-${"b".repeat(24)}` }).outcome).toBe(
      "blocked",
    );
    expect(plan({ ...evidence(), targetEnvironment: "preprod" }).outcome).toBe("blocked");
  });
  it("validates the independent allowlist and returns deterministic sanitized output", () => {
    expect(
      planLegacyOwnerBootstrap({ ...expected, ownerIds: ids.slice(1) }, evidence(), now).outcome,
    ).toBe("blocked");
    expect(
      planLegacyOwnerBootstrap({ ...expected, ownerIds: Array(8).fill(ids[0]) }, evidence(), now)
        .outcome,
    ).toBe("blocked");
    const input = evidence();
    input.owners.reverse();
    Object.assign(input.owners[0]!, {
      email: "not-for-output@example.invalid",
      password: "synthetic",
    });
    expect(plan(input)).toEqual(plan());
    expect(JSON.stringify(plan(input))).not.toContain("example.invalid");
  });
});
