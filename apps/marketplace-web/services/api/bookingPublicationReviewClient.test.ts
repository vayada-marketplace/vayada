import { expect, it, vi } from "vitest";
import {
  createProductReadinessResult,
  READINESS_GROUP_IDS_BY_PRODUCT,
} from "@vayada/domain-hotels";
import { createBookingPublicationReviewClient } from "./bookingPublicationReviewClient";
const propertyId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const source = {
  ownerDomain: "booking" as const,
  entityType: "settings",
  entityId: propertyId,
  revision: "1",
};
async function harness() {
  const readiness = await createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "booking",
    status: "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [source],
    },
    groups: READINESS_GROUP_IDS_BY_PRODUCT.booking.map((groupId) => ({
      groupId,
      status: "ready",
      steps: [
        {
          owningStepId: "booking_design",
          status: "ready",
          entities: [{ source, status: "ready", blockers: [] }],
        },
      ],
    })),
    evaluatedAt: "2026-09-11T00:00:00.000Z",
  });
  const operation = {
    operationId,
    propertyId,
    status: "pending",
    expectedActiveContentRevisionId: null,
    resultContentRevisionId: null,
    failureCode: null,
    requestedAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    completedAt: null,
  };
  const review = {
    contractVersion: "booking-publication-review.v1",
    propertyId,
    activeContentRevisionId: null,
    publishedUrl: null,
    latestOperation: operation,
    recoveredOperation: operation,
    readiness,
  };
  const http = {
    get: vi.fn().mockResolvedValue(review),
    post: vi.fn().mockResolvedValue(operation),
  };
  const attempt = {
    propertyId,
    idempotencyKey: "persisted-attempt",
    body: {
      expectedActiveContentRevisionId: null,
      expectedSourceManifestHash: readiness.sourceManifestHash,
      expectedReadinessHash: readiness.readinessHash,
    },
  };
  return { client: createBookingPublicationReviewClient(http), http, review, attempt, operation };
}
it("reads and recovers without posting a publication", async () => {
  const h = await harness();
  expect(await h.client.load(propertyId, "saved-key")).toMatchObject(h.review);
  expect(h.http.post).not.toHaveBeenCalled();
  expect(h.http.get.mock.calls[0][1]).toMatchObject({
    cache: "no-store",
    headers: { "Idempotency-Key": "saved-key" },
  });
});
it("rejects readiness hash tampering and foreign scopes", async () => {
  const h = await harness();
  await expect(h.client.load(operationId)).rejects.toThrow();
  h.http.get.mockResolvedValue({
    ...h.review,
    readiness: { ...h.review.readiness, readinessHash: `sha256:${"0".repeat(64)}` },
  });
  await expect(h.client.load(propertyId)).rejects.toThrow();
});
it("retains a recovered operation when readiness is unavailable", async () => {
  const h = await harness();
  h.http.get.mockResolvedValue({
    ...h.review,
    readiness: {
      outcome: "provider_failure",
      contractVersion: "onboarding-product-readiness.v1",
      propertyId,
      product: "booking",
      status: "error",
      error: {
        kind: "system_error",
        errorSource: "provider",
        message: "Temporarily unavailable",
        retryable: true,
      },
    },
  });
  expect(await h.client.load(propertyId)).toMatchObject({
    latestOperation: h.operation,
    readiness: { status: "error" },
  });
});
it("retries exactly the saved command and keeps pending distinct from success", async () => {
  const h = await harness();
  h.http.post.mockRejectedValueOnce(new Error("response lost"));
  await expect(h.client.publish(h.attempt)).rejects.toThrow("response lost");
  expect((await h.client.publish(h.attempt)).status).toBe("pending");
  expect(h.http.post.mock.calls[0]).toEqual(h.http.post.mock.calls[1]);
});
it("rejects incomplete success and wrong property operations", async () => {
  const h = await harness();
  h.http.post.mockResolvedValue({ ...h.operation, status: "succeeded" });
  await expect(h.client.publish(h.attempt)).rejects.toThrow();
  h.http.get.mockResolvedValue({
    ...h.review,
    recoveredOperation: { ...h.operation, propertyId: operationId },
  });
  await expect(h.client.load(propertyId)).rejects.toThrow();
});
it("rejects denied access without manufacturing an empty review", async () => {
  const h = await harness();
  h.http.get.mockRejectedValue(new Error("Forbidden"));
  await expect(h.client.load(propertyId)).rejects.toThrow("Forbidden");
});

it("keeps unknown recoverable and accepts complete succeeded operations", async () => {
  const h = await harness();
  h.http.post.mockResolvedValue({
    ...h.operation,
    status: "unknown",
    failureCode: "external_result_unconfirmed",
  });
  expect((await h.client.publish(h.attempt)).status).toBe("unknown");
  h.http.post.mockResolvedValue({
    ...h.operation,
    status: "succeeded",
    resultContentRevisionId: operationId,
    completedAt: "2026-09-11T00:01:00.000Z",
  });
  expect((await h.client.publish(h.attempt)).status).toBe("succeeded");
});

it("offers only a safe URL tied to an active revision", async () => {
  const h = await harness();
  h.http.get.mockResolvedValue({
    ...h.review,
    publishedUrl: "https://hotel.booking.test",
    activeContentRevisionId: operationId,
  });
  expect((await h.client.load(propertyId)).publishedUrl).toBe("https://hotel.booking.test");
  h.http.get.mockResolvedValue({ ...h.review, publishedUrl: "https://hotel.booking.test" });
  await expect(h.client.load(propertyId)).rejects.toThrow();
  h.http.get.mockResolvedValue({
    ...h.review,
    publishedUrl: "javascript:alert(1)",
    activeContentRevisionId: operationId,
  });
  await expect(h.client.load(propertyId)).rejects.toThrow();
});
