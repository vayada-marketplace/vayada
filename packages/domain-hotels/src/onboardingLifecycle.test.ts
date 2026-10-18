import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createLiveAriSourceRevision,
  createReadyProductReadinessEvidence,
  type BookingActiveContentPointer,
  type BookingContentRevisionId,
  type LiveAriSourceRevision,
  type LiveAriWatermark,
  type OnboardingLifecycleJsonValue,
  type ReadyProductReadinessEvidence,
} from "./onboardingLifecycle.js";
import {
  createProductReadinessResult,
  type ProductReadinessEvaluation,
  type ProductReadinessResult,
} from "./onboardingReadiness.js";

function assertCompileTimeLifecycleBoundaries(
  bookingEvidence: ReadyProductReadinessEvidence<"booking">,
  bookingPointer: BookingActiveContentPointer,
  ariWatermark: LiveAriWatermark,
): void {
  // @ts-expect-error Hashed manifest sources are deeply immutable.
  bookingEvidence.sourceManifest.sources[0]!.revision = "mutated";
  // @ts-expect-error Lifecycle state results are readonly snapshots.
  bookingPointer.revisionId = "mutated" as BookingContentRevisionId;
  // @ts-expect-error Lifecycle state results are readonly snapshots.
  ariWatermark.watermarkRevision = 2;
}

void assertCompileTimeLifecycleBoundaries;

function readyBookingEvaluation(): ProductReadinessEvaluation {
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const source = {
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile",
    entityId: propertyId,
    revision: "profile-r1",
  };
  return {
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "booking",
    status: "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [source],
    },
    groups: [
      {
        groupId: "booking.hotel_profile",
        status: "ready",
        steps: [
          {
            owningStepId: "present_hotel",
            status: "ready",
            entities: [{ source, status: "ready", blockers: [] }],
          },
        ],
      },
    ],
    evaluatedAt: "2026-08-02T12:00:00.000Z",
  };
}

describe("onboarding publication lifecycle contracts", () => {
  it("keeps revision identities and JSON snapshots apart", () => {
    expectTypeOf<ReadyProductReadinessEvidence<"booking">["product"]>().toEqualTypeOf<"booking">();
    expectTypeOf<ReadyProductReadinessEvidence<"booking">["status"]>().toEqualTypeOf<"ready">();
    expectTypeOf<Date>().not.toMatchTypeOf<OnboardingLifecycleJsonValue>();
    expectTypeOf<LiveAriSourceRevision>().not.toEqualTypeOf<BookingContentRevisionId>();
  });

  it("creates detached evidence only after recomputing its hashes", async () => {
    const result = await createProductReadinessResult(readyBookingEvaluation());
    const mutableResult = structuredClone(result) as ProductReadinessResult;
    const evidence = await createReadyProductReadinessEvidence(mutableResult, {
      propertyId: mutableResult.propertyId,
      product: "booking",
    });

    expect(evidence).toMatchObject({
      contractVersion: "onboarding-product-readiness.v1",
      propertyId: result.propertyId,
      product: "booking",
      status: "ready",
      sourceManifestHash: result.sourceManifestHash,
      readinessHash: result.readinessHash,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.sourceManifest.sources[0])).toBe(true);
    expect(evidence.sourceManifest).not.toBe(mutableResult.sourceManifest);
    expect(Object.isFrozen(mutableResult.sourceManifest)).toBe(false);
    (mutableResult.sourceManifest.sources[0] as { revision: string }).revision = "caller-r2";
    expect(evidence.sourceManifest.sources[0]!.revision).toBe("profile-r1");

    const tampered = {
      ...result,
      readinessHash: `sha256:${"0".repeat(64)}`,
    } as ProductReadinessResult;
    await expect(
      createReadyProductReadinessEvidence(tampered, {
        propertyId: result.propertyId,
        product: "booking",
      }),
    ).rejects.toThrow("hashes do not match");
    await expect(
      createReadyProductReadinessEvidence(result, {
        propertyId: result.propertyId,
        // Only Booking is a readiness product now; a mismatch is still refused at runtime.
        product: "marketplace" as never,
      }),
    ).rejects.toThrow("different product");
  });

  it("brands non-empty live ARI source revisions", () => {
    expect(createLiveAriSourceRevision("pms-inventory-r7")).toBe("pms-inventory-r7");
    expect(() => createLiveAriSourceRevision("  ")).toThrow("non-empty string");
  });
});
