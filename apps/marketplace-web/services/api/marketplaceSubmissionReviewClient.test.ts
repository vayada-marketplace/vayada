import { expect, it, vi } from "vitest";
import {
  createProductReadinessResult,
  READINESS_GROUP_IDS_BY_PRODUCT,
} from "@vayada/domain-hotels";
import { createMarketplaceSubmissionReviewClient } from "./marketplaceSubmissionReviewClient";
const propertyId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
async function harness() {
  const source = {
    ownerDomain: "marketplace" as const,
    entityType: "settings",
    entityId: propertyId,
    revision: "1",
  };
  const readiness = await createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "marketplace",
    status: "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [source],
    },
    groups: READINESS_GROUP_IDS_BY_PRODUCT.marketplace.map((groupId) => ({
      groupId,
      status: "ready",
      steps: [
        {
          owningStepId: "marketplace_preferences",
          status: "ready",
          entities: [{ source, status: "ready", blockers: [] }],
        },
      ],
    })),
    evaluatedAt: new Date().toISOString(),
  });
  const receipt = {
    revisionId,
    propertyId,
    revisionNumber: 1,
    status: "pending",
    submittedAt: new Date().toISOString(),
    decisionReason: null,
  };
  const review = {
    contractVersion: "marketplace-submission-review.v1",
    propertyId,
    latestSubmission: receipt,
    recoveredSubmission: receipt,
    activeSubmission: null,
    readiness,
  };
  const http = { get: vi.fn().mockResolvedValue(review), post: vi.fn().mockResolvedValue(receipt) };
  const attempt = {
    propertyId,
    idempotencyKey: "saved",
    body: {
      expectedLatestSubmissionRevisionId: null,
      expectedSourceManifestHash: readiness.sourceManifestHash,
      expectedReadinessHash: readiness.readinessHash,
    },
  };
  return { client: createMarketplaceSubmissionReviewClient(http), http, review, receipt, attempt };
}
it("reads scoped recovery without submitting", async () => {
  const h = await harness();
  expect(await h.client.load(propertyId, "saved")).toMatchObject(h.review);
  expect(h.http.post).not.toHaveBeenCalled();
  expect(h.http.get.mock.calls[0][1]).toMatchObject({
    cache: "no-store",
    headers: { "Idempotency-Key": "saved" },
  });
});
it("retries the exact stored command and keeps moderation pending", async () => {
  const h = await harness();
  h.http.post.mockRejectedValueOnce(new Error("lost"));
  await expect(h.client.submit(h.attempt)).rejects.toThrow("lost");
  expect((await h.client.submit(h.attempt)).status).toBe("pending");
  expect(h.http.post.mock.calls[0]).toEqual(h.http.post.mock.calls[1]);
});
it("rejects foreign scopes, fabricated hashes, and incomplete groups", async () => {
  const h = await harness();
  await expect(h.client.load(revisionId)).rejects.toThrow();
  h.http.get.mockResolvedValue({
    ...h.review,
    readiness: { ...h.review.readiness, readinessHash: `sha256:${"0".repeat(64)}` },
  });
  await expect(h.client.load(propertyId)).rejects.toThrow();
  const partial = await createProductReadinessResult({
    ...h.review.readiness,
    groups: h.review.readiness.groups.slice(0, 1),
  });
  h.http.get.mockResolvedValue({ ...h.review, readiness: partial });
  await expect(h.client.load(propertyId)).rejects.toThrow();
});
it("preserves pending submission when readiness is unavailable", async () => {
  const h = await harness();
  h.http.get.mockResolvedValue({
    ...h.review,
    readiness: {
      contractVersion: "onboarding-product-readiness.v1",
      propertyId,
      product: "marketplace",
      outcome: "provider_failure",
      status: "error",
      error: {
        kind: "system_error",
        errorSource: "provider",
        message: "Unavailable",
        retryable: true,
      },
    },
  });
  expect(await h.client.load(propertyId)).toMatchObject({
    recoveredSubmission: h.receipt,
    readiness: { status: "error" },
  });
});
it("does not turn malformed or denied responses into submission success", async () => {
  const h = await harness();
  h.http.post.mockResolvedValue({ ...h.receipt, propertyId: revisionId });
  await expect(h.client.submit(h.attempt)).rejects.toThrow();
  h.http.get.mockRejectedValue(new Error("Forbidden"));
  await expect(h.client.load(propertyId)).rejects.toThrow("Forbidden");
});

it("rejects invalid moderation and activation states", async () => {
  const h = await harness();
  h.http.get.mockResolvedValue({
    ...h.review,
    latestSubmission: { ...h.receipt, status: "published" },
  });
  await expect(h.client.load(propertyId)).rejects.toThrow();
  h.http.get.mockResolvedValue({
    ...h.review,
    activeSubmission: { revisionId, status: "pending" },
  });
  await expect(h.client.load(propertyId)).rejects.toThrow();
});
