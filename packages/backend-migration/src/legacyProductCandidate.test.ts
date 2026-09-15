import { describe, expect, it } from "vitest";
import {
  evaluateLegacyProductCandidate,
  type LegacyProductCandidateInput,
} from "./legacyProductCandidate.js";

const candidate: LegacyProductCandidateInput = {
  product: "pms",
  sourceOwnerId: "synthetic-owner",
  targetOwnerId: "synthetic-owner",
  sourcePropertyId: "synthetic-hotel",
  linkedLegacyPropertyId: "synthetic-hotel",
  sourceUserStatus: "pending",
  sourceProductStatus: "active",
  ownershipMatchCount: 1,
  currentRestrictionCheck: "clear",
  protectedFixture: false,
};

describe("legacy product candidate preflight (never grants access)", () => {
  it("requires further proof for an exact pending PMS candidate without mutation", () => {
    const input = Object.freeze({ ...candidate });
    expect(evaluateLegacyProductCandidate(input)).toEqual({
      outcome: "requires_evidence_verification",
    });
    expect(input).toEqual(candidate);
  });

  it.each(["pending", "rejected", "suspended", null, "active"])(
    "does not treat Marketplace profile status %s as approval",
    (sourceProductStatus) => {
      expect(
        evaluateLegacyProductCandidate({
          ...candidate,
          product: "marketplace",
          sourceUserStatus: "verified",
          sourceProductStatus,
        }).outcome,
      ).toBe("blocked");
    },
  );

  it("evaluates both products independently, including the user approval gate", () => {
    expect(
      evaluateLegacyProductCandidate({
        ...candidate,
        sourceUserStatus: "verified",
      }).outcome,
    ).toBe("requires_evidence_verification");
    expect(
      evaluateLegacyProductCandidate({
        ...candidate,
        sourceUserStatus: "verified",
        sourceProductStatus: "verified",
      }).outcome,
    ).toBe("blocked");
    expect(
      evaluateLegacyProductCandidate({
        ...candidate,
        product: "marketplace",
        sourceProductStatus: "verified",
      }).outcome,
    ).toBe("blocked");
    expect(
      evaluateLegacyProductCandidate({
        ...candidate,
        product: "marketplace",
        sourceUserStatus: "verified",
        sourceProductStatus: "verified",
      }).outcome,
    ).toBe("requires_evidence_verification");
    expect(
      evaluateLegacyProductCandidate({
        ...candidate,
        sourceUserStatus: "verified",
        sourceProductStatus: null,
      }).outcome,
    ).toBe("blocked");
  });

  it.each(["rejected", "suspended", "deleted", "active", "unknown", null])(
    "rejects restricted or unknown legacy user status %s",
    (sourceUserStatus) => {
      expect(evaluateLegacyProductCandidate({ ...candidate, sourceUserStatus }).outcome).toBe(
        "blocked",
      );
    },
  );

  it.each<Partial<LegacyProductCandidateInput>>([
    { targetOwnerId: "other-owner" },
    { linkedLegacyPropertyId: "other-hotel" },
    { sourceOwnerId: "", targetOwnerId: "" },
    { sourcePropertyId: " ", linkedLegacyPropertyId: " " },
    { ownershipMatchCount: 0 },
    { ownershipMatchCount: 2 },
    { currentRestrictionCheck: "denied" },
    { currentRestrictionCheck: "unknown" },
    { protectedFixture: true },
    { sourceProductStatus: "inactive" },
    { sourceProductStatus: null },
  ])("blocks unsafe evidence %j", (patch) => {
    expect(evaluateLegacyProductCandidate({ ...candidate, ...patch }).outcome).toBe("blocked");
  });

  it("keeps all eight pending/absent Marketplace snapshot shapes unapproved", () => {
    for (let index = 0; index < 8; index++) {
      expect(
        evaluateLegacyProductCandidate({
          ...candidate,
          product: "marketplace",
          sourceProductStatus: index < 4 ? "pending" : null,
        }).outcome,
      ).toBe("blocked");
    }
  });
});
