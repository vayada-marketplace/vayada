import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import { createProductReadinessResult } from "@vayada/domain-hotels";
const mocks = vi.hoisted(() => ({ load: vi.fn(), publish: vi.fn() }));
vi.mock("@/services/api/bookingPublicationReviewClient", () => ({
  bookingPublicationReviewClient: mocks,
}));
import { BookingReviewCard } from "./BookingReviewCard";
import { readBookingPublicationAttempt } from "./bookingPublicationAttemptStorage";
const propertyId = "22222222-2222-4222-8222-222222222222";
const organizationId = "org";
let store: Storage;
let review: Awaited<ReturnType<typeof makeReview>>;
let trees: ReactTestRenderer[] = [];
async function makeReview() {
  const source = {
    ownerDomain: "booking" as const,
    entityType: "settings",
    entityId: propertyId,
    revision: "1",
  };
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
    groups: [
      {
        groupId: "booking.page_style",
        status: "ready",
        steps: [
          {
            owningStepId: "booking_design",
            status: "ready",
            entities: [{ source, status: "ready", blockers: [] }],
          },
        ],
      },
    ],
    evaluatedAt: "2026-09-11T00:00:00.000Z",
  });
  return {
    contractVersion: "booking-publication-review.v1",
    propertyId,
    activeContentRevisionId: null,
    publishedUrl: null,
    latestOperation: null,
    recoveredOperation: null,
    readiness,
  };
}
const operation = { operationId: "op", propertyId, status: "pending", failureCode: null };
beforeEach(async () => {
  vi.resetAllMocks();
  const values = new Map<string, string>();
  store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  } as Storage;
  vi.stubGlobal("window", { localStorage: store });
  vi.stubGlobal("navigator", {
    locks: { request: async (_key: string, action: () => unknown) => action() },
  });
  review = await makeReview();
  mocks.load.mockResolvedValue(review);
  mocks.publish.mockResolvedValue(operation);
});
afterEach(async () => {
  await act(async () => {
    trees.forEach((tree) => tree.unmount());
  });
  trees = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(id = propertyId) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(BookingReviewCard, { propertyId: id, organizationId, onEdit: vi.fn() }),
    );
  });
  trees.push(tree);
  return tree;
}
const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());
async function click(tree: ReactTestRenderer, label: string) {
  const button = tree.root
    .findAllByType("button")
    .find((button) => button.children.join("") === label);
  expect(button).toBeDefined();
  await act(async () => {
    button!.props.onClick();
  });
}
it("only reads on entry and persists the exact command before publication", async () => {
  const tree = await mount();
  expect(mocks.publish).not.toHaveBeenCalled();
  mocks.publish.mockImplementation(async (attempt) => {
    expect(readBookingPublicationAttempt(store, organizationId, propertyId)).toEqual(attempt);
    mocks.load.mockResolvedValue({
      ...review,
      recoveredOperation: operation,
      latestOperation: operation,
    });
    return operation;
  });
  await click(tree, "Publish booking page");
  expect(mocks.publish).toHaveBeenCalledTimes(1);
  expect(text(tree)).toContain("Publishing booking page");
  expect(text(tree)).not.toContain('"Published"');
});
it("explains when automatic status checks stop and restarts them on manual refresh", async () => {
  vi.useFakeTimers();
  mocks.load.mockResolvedValue({ ...review, latestOperation: operation });
  const tree = await mount();
  for (let count = 0; count < 5; count++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  }
  expect(mocks.load).toHaveBeenCalledTimes(6);
  expect(text(tree)).toContain("Publication still pending");
  expect(text(tree)).toContain("Automatic checking stopped");
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mocks.load).toHaveBeenCalledTimes(6);
  await click(tree, "Refresh Booking status");
  expect(text(tree)).not.toContain("Automatic checking stopped");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(mocks.load).toHaveBeenCalledTimes(8);
  expect(mocks.publish).not.toHaveBeenCalled();
});
it("restores a lost response and retries the exact saved request", async () => {
  let tree = await mount();
  mocks.publish.mockRejectedValue(new Error("response lost"));
  await click(tree, "Publish booking page");
  const original = mocks.publish.mock.calls[0][0];
  await act(async () => tree.unmount());
  tree = await mount();
  expect(mocks.load).toHaveBeenLastCalledWith(propertyId, original.idempotencyKey);
  await click(tree, "Retry saved publication request");
  expect(mocks.publish.mock.calls[1][0]).toEqual(original);
});
it("lets a confirmed rejected request be replaced only after checking recovery", async () => {
  const tree = await mount();
  mocks.publish.mockRejectedValueOnce(
    new ApiErrorResponse(409, { code: "invalid_readiness_evidence" }),
  );
  await click(tree, "Publish booking page");
  const original = mocks.publish.mock.calls[0][0];
  await click(tree, "Review latest settings");
  expect(mocks.load).toHaveBeenLastCalledWith(propertyId, original.idempotencyKey);
  expect(readBookingPublicationAttempt(store, organizationId, propertyId)).toBeNull();
  await click(tree, "Publish booking page");
  expect(mocks.publish.mock.calls[1][0].idempotencyKey).not.toBe(original.idempotencyKey);
});
it("retains a recovered accepted request even after a rejection response", async () => {
  const tree = await mount();
  mocks.publish.mockRejectedValueOnce(
    new ApiErrorResponse(409, { code: "invalid_readiness_evidence" }),
  );
  await click(tree, "Publish booking page");
  mocks.load.mockResolvedValue({
    ...review,
    recoveredOperation: operation,
    latestOperation: operation,
  });
  await click(tree, "Review latest settings");
  expect(readBookingPublicationAttempt(store, organizationId, propertyId)).not.toBeNull();
  expect(text(tree)).toContain("Publishing booking page");
});
it("does not publish when browser storage cannot persist recovery", async () => {
  const tree = await mount();
  store.setItem = () => {
    throw new Error("storage denied");
  };
  await click(tree, "Publish booking page");
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(text(tree)).toContain("could not save this publication request");
});
it("does not expose publication after denied access", async () => {
  mocks.load.mockRejectedValue(new ApiErrorResponse(403, { message: "Forbidden" }));
  const tree = await mount();
  expect(text(tree)).not.toContain("Publish booking page");
  expect(mocks.publish).not.toHaveBeenCalled();
});
it("keeps the previous published page when an update fails", async () => {
  mocks.load.mockResolvedValue({
    ...review,
    activeContentRevisionId: "active",
    publishedUrl: "https://hotel.example",
    latestOperation: { ...operation, status: "failed", failureCode: "source_content_changed" },
  });
  const tree = await mount();
  expect(text(tree)).toContain("previous page remains published");
  expect(tree.root.findByType("a").props.href).toBe("https://hotel.example");
});
it("ignores an old property's response after scope changes", async () => {
  let resolve!: (value: unknown) => void;
  mocks.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const tree = await mount();
  mocks.load.mockRejectedValue(new Error("Other property unavailable"));
  await act(async () => {
    tree.update(
      createElement(BookingReviewCard, { propertyId: "other", organizationId, onEdit: vi.fn() }),
    );
  });
  await act(async () => resolve(review));
  expect(text(tree)).not.toContain("Publish booking page");
  expect(text(tree)).toContain("Other property unavailable");
});

it("blocks publication after a refresh loses authorization", async () => {
  const tree = await mount();
  mocks.load.mockRejectedValue(new ApiErrorResponse(403, { message: "Forbidden" }));
  await click(tree, "Refresh Booking status");
  expect(text(tree)).not.toContain("Publish booking page");
});
it("does not overwrite another tab's saved request", async () => {
  const tree = await mount();
  const attempt = {
    propertyId,
    idempotencyKey: "other-tab",
    body: {
      expectedActiveContentRevisionId: null,
      expectedReadinessHash: review.readiness.readinessHash,
      expectedSourceManifestHash: review.readiness.sourceManifestHash,
    },
  };
  store.setItem(
    `vayada:booking-publication:${organizationId}:${propertyId}`,
    JSON.stringify(attempt),
  );
  await click(tree, "Publish booking page");
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(readBookingPublicationAttempt(store, organizationId, propertyId)).toEqual(attempt);
});

function persisted(key: string) {
  const attempt = {
    propertyId,
    idempotencyKey: key,
    body: {
      expectedActiveContentRevisionId: null,
      expectedReadinessHash: review.readiness.readinessHash,
      expectedSourceManifestHash: review.readiness.sourceManifestHash,
    },
  };
  store.setItem(
    `vayada:booking-publication:${organizationId}:${propertyId}`,
    JSON.stringify(attempt),
  );
  return attempt;
}
it("does not use a previous completed operation to resolve a new lost response", async () => {
  persisted("completed-A");
  const completed = { ...operation, status: "succeeded" };
  mocks.load.mockResolvedValue({
    ...review,
    recoveredOperation: completed,
    latestOperation: completed,
  });
  const tree = await mount();
  mocks.publish.mockRejectedValue(new Error("response lost"));
  await click(tree, "Publish booking page");
  const attemptB = mocks.publish.mock.calls[0][0];
  expect(text(tree)).toContain("Retry saved publication request");
  await click(tree, "Retry saved publication request");
  expect(mocks.publish.mock.calls[1][0]).toEqual(attemptB);
});
it("does not transfer rejection authorization to another tab's request", async () => {
  const tree = await mount();
  mocks.publish.mockRejectedValue(
    new ApiErrorResponse(409, { code: "invalid_readiness_evidence" }),
  );
  await click(tree, "Publish booking page");
  const other = persisted("unconfirmed-B");
  await click(tree, "Refresh Booking status");
  expect(text(tree)).not.toContain("Review latest settings");
  expect(text(tree)).toContain("Retry saved publication request");
  expect(readBookingPublicationAttempt(store, organizationId, propertyId)).toEqual(other);
});
it("recovers from a durably rejected concurrent publication", async () => {
  const tree = await mount();
  mocks.publish.mockRejectedValue(new ApiErrorResponse(409, { code: "publication_in_progress" }));
  await click(tree, "Publish booking page");
  await click(tree, "Review latest settings");
  expect(readBookingPublicationAttempt(store, organizationId, propertyId)).toBeNull();
  expect(text(tree)).toContain("Publish booking page");
});
it("keeps a newer pending operation ahead of recovered completed work", async () => {
  persisted("completed-A");
  mocks.load.mockResolvedValue({
    ...review,
    recoveredOperation: { ...operation, status: "succeeded" },
    latestOperation: { ...operation, operationId: "new-B" },
  });
  const tree = await mount();
  expect(text(tree)).toContain("Publishing booking page");
  expect(text(tree)).not.toContain('"Publish booking page"');
});
