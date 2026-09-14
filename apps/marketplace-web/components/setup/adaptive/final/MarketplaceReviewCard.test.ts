import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import { createProductReadinessResult } from "@vayada/domain-hotels";
const mocks = vi.hoisted(() => ({ load: vi.fn(), submit: vi.fn() }));
vi.mock("@/services/api/marketplaceSubmissionReviewClient", () => ({
  marketplaceSubmissionReviewClient: mocks,
}));
import { MarketplaceReviewCard } from "./MarketplaceReviewCard";
import { readMarketplaceSubmissionAttempt } from "./marketplaceSubmissionAttemptStorage";
const propertyId = "22222222-2222-4222-8222-222222222222";
const organizationId = "org";
let store: Storage;
let review: Awaited<ReturnType<typeof makeReview>>;
let trees: ReactTestRenderer[] = [];
async function makeReview() {
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
    groups: [
      {
        groupId: "marketplace.hotel_profile",
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
    evaluatedAt: "2026-09-11T00:00:00.000Z",
  });
  return {
    contractVersion: "marketplace-submission-review.v1",
    propertyId,
    activeSubmission: null,
    latestSubmission: null,
    recoveredSubmission: null,
    readiness,
  };
}
const operation = {
  revisionId: "33333333-3333-4333-8333-333333333333",
  propertyId,
  status: "pending",
  revisionNumber: 1,
  decisionReason: null,
  submittedAt: new Date().toISOString(),
};
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
  mocks.submit.mockResolvedValue(operation);
});
afterEach(async () => {
  await act(async () => {
    trees.forEach((tree) => tree.unmount());
  });
  trees = [];
  vi.unstubAllGlobals();
});
async function mount(id = propertyId) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(MarketplaceReviewCard, { propertyId: id, organizationId, onEdit: vi.fn() }),
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
it("only reads on entry and persists the exact command before submission", async () => {
  const tree = await mount();
  expect(mocks.submit).not.toHaveBeenCalled();
  mocks.submit.mockImplementation(async (attempt) => {
    expect(readMarketplaceSubmissionAttempt(store, organizationId, propertyId)).toEqual(attempt);
    mocks.load.mockResolvedValue({
      ...review,
      recoveredSubmission: operation,
      latestSubmission: operation,
    });
    return operation;
  });
  await click(tree, "Submit to Marketplace");
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(text(tree)).toContain("Pending review");
  expect(text(tree)).not.toContain('"Published"');
});
it("restores a lost response and retries the exact saved request", async () => {
  let tree = await mount();
  mocks.submit.mockRejectedValue(new Error("response lost"));
  await click(tree, "Submit to Marketplace");
  const original = mocks.submit.mock.calls[0][0];
  await act(async () => tree.unmount());
  tree = await mount();
  expect(mocks.load).toHaveBeenLastCalledWith(propertyId, original.idempotencyKey);
  await click(tree, "Retry saved submission request");
  expect(mocks.submit.mock.calls[1][0]).toEqual(original);
});
it("lets a confirmed rejected request be replaced only after checking recovery", async () => {
  const tree = await mount();
  mocks.submit.mockRejectedValueOnce(
    new ApiErrorResponse(409, { code: "invalid_readiness_evidence" }),
  );
  await click(tree, "Submit to Marketplace");
  const original = mocks.submit.mock.calls[0][0];
  await click(tree, "Review latest settings");
  expect(mocks.load).toHaveBeenLastCalledWith(propertyId, original.idempotencyKey);
  expect(readMarketplaceSubmissionAttempt(store, organizationId, propertyId)).toBeNull();
  await click(tree, "Submit to Marketplace");
  expect(mocks.submit.mock.calls[1][0].idempotencyKey).not.toBe(original.idempotencyKey);
});
it("retains a recovered accepted request even after a rejection response", async () => {
  const tree = await mount();
  mocks.submit.mockRejectedValueOnce(
    new ApiErrorResponse(409, { code: "invalid_readiness_evidence" }),
  );
  await click(tree, "Submit to Marketplace");
  mocks.load.mockResolvedValue({
    ...review,
    recoveredSubmission: operation,
    latestSubmission: operation,
  });
  await click(tree, "Review latest settings");
  expect(readMarketplaceSubmissionAttempt(store, organizationId, propertyId)).not.toBeNull();
  expect(text(tree)).toContain("Pending review");
});
it("does not submit when browser storage cannot persist recovery", async () => {
  const tree = await mount();
  store.setItem = () => {
    throw new Error("storage denied");
  };
  await click(tree, "Submit to Marketplace");
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(text(tree)).toContain("could not save this submission request");
});
it("does not expose submission after denied access", async () => {
  mocks.load.mockRejectedValue(new ApiErrorResponse(403, { message: "Forbidden" }));
  const tree = await mount();
  expect(text(tree)).not.toContain("Submit to Marketplace");
  expect(mocks.submit).not.toHaveBeenCalled();
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
      createElement(MarketplaceReviewCard, {
        propertyId: "other",
        organizationId,
        onEdit: vi.fn(),
      }),
    );
  });
  await act(async () => resolve(review));
  expect(text(tree)).not.toContain("Submit to Marketplace");
  expect(text(tree)).toContain("Other property unavailable");
});

it("blocks submission after a refresh loses authorization", async () => {
  const tree = await mount();
  mocks.load.mockRejectedValue(new ApiErrorResponse(403, { message: "Forbidden" }));
  await click(tree, "Refresh Marketplace status");
  expect(text(tree)).not.toContain("Submit to Marketplace");
});
it("does not overwrite another tab's saved request", async () => {
  const tree = await mount();
  const attempt = {
    propertyId,
    idempotencyKey: "other-tab",
    body: {
      expectedLatestSubmissionRevisionId: null,
      expectedReadinessHash: review.readiness.readinessHash,
      expectedSourceManifestHash: review.readiness.sourceManifestHash,
    },
  };
  store.setItem(
    `vayada:marketplace-submission:${organizationId}:${propertyId}`,
    JSON.stringify(attempt),
  );
  await click(tree, "Submit to Marketplace");
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readMarketplaceSubmissionAttempt(store, organizationId, propertyId)).toEqual(attempt);
});

function persisted(key: string) {
  const attempt = {
    propertyId,
    idempotencyKey: key,
    body: {
      expectedLatestSubmissionRevisionId: null,
      expectedReadinessHash: review.readiness.readinessHash,
      expectedSourceManifestHash: review.readiness.sourceManifestHash,
    },
  };
  store.setItem(
    `vayada:marketplace-submission:${organizationId}:${propertyId}`,
    JSON.stringify(attempt),
  );
  return attempt;
}
it("does not use a previous completed operation to resolve a new lost response", async () => {
  persisted("completed-A");
  const completed = { ...operation, status: "approved" };
  mocks.load.mockResolvedValue({
    ...review,
    recoveredSubmission: completed,
    latestSubmission: completed,
  });
  const tree = await mount();
  mocks.submit.mockRejectedValue(new Error("response lost"));
  await click(tree, "Resubmit to Marketplace");
  const attemptB = mocks.submit.mock.calls[0][0];
  expect(text(tree)).toContain("Retry saved submission request");
  await click(tree, "Retry saved submission request");
  expect(mocks.submit.mock.calls[1][0]).toEqual(attemptB);
});
it("does not transfer rejection authorization to another tab's request", async () => {
  const tree = await mount();
  mocks.submit.mockRejectedValue(new ApiErrorResponse(409, { code: "invalid_readiness_evidence" }));
  await click(tree, "Submit to Marketplace");
  const other = persisted("unconfirmed-B");
  await click(tree, "Refresh Marketplace status");
  expect(text(tree)).not.toContain("Review latest settings");
  expect(text(tree)).toContain("Retry saved submission request");
  expect(readMarketplaceSubmissionAttempt(store, organizationId, propertyId)).toEqual(other);
});
it("recovers from a durably rejected concurrent submission", async () => {
  const tree = await mount();
  mocks.submit.mockRejectedValue(new ApiErrorResponse(409, { code: "submission_pending_review" }));
  await click(tree, "Submit to Marketplace");
  await click(tree, "Review latest settings");
  expect(readMarketplaceSubmissionAttempt(store, organizationId, propertyId)).toBeNull();
  expect(text(tree)).toContain("Submit to Marketplace");
});
it("keeps a newer pending operation ahead of recovered completed work", async () => {
  persisted("completed-A");
  mocks.load.mockResolvedValue({
    ...review,
    recoveredSubmission: { ...operation, status: "approved" },
    latestSubmission: { ...operation, revisionId: "44444444-4444-4444-8444-444444444444" },
  });
  const tree = await mount();
  expect(text(tree)).toContain("Pending review");
  expect(text(tree)).not.toContain('"Submit to Marketplace"');
});

it("shows requested changes without treating them as publication", async () => {
  mocks.load.mockResolvedValue({
    ...review,
    latestSubmission: {
      ...operation,
      status: "changes_requested",
      decisionReason: "Please update your summary.",
    },
  });
  const tree = await mount();
  expect(text(tree)).toContain("Changes requested");
  expect(text(tree)).toContain("Please update your summary.");
  expect(text(tree)).not.toContain("Open Marketplace profile");
});
it("keeps suspended profiles private and prevents resubmission from implying reinstatement", async () => {
  mocks.load.mockResolvedValue({
    ...review,
    activeSubmission: { revisionId: "active", status: "suspended" },
    latestSubmission: { ...operation, status: "approved" },
  });
  const tree = await mount();
  expect(text(tree)).toContain("Suspended");
  expect(text(tree)).not.toContain("Resubmit to Marketplace");
  expect(text(tree)).not.toContain("Open Marketplace profile");
});

it("withholds the unavailable public page while preserving active status", async () => {
  mocks.load.mockResolvedValue({
    ...review,
    activeSubmission: { revisionId: "active", status: "active" },
  });
  const tree = await mount();
  expect(text(tree)).toContain("Published");
  expect(text(tree)).toContain("public Marketplace page is currently unavailable");
  expect(tree.root.findAllByType("a")).toHaveLength(0);
});

it("opens the verified public profile without submitting or leaving setup", async () => {
  mocks.load.mockResolvedValue({
    ...review,
    activeSubmission: { revisionId: "active", status: "active" },
    publishedUrl: `/hotels/${propertyId}`,
  });
  const tree = await mount();
  const link = tree.root.findByType("a");
  expect(link.props.href).toBe(`/hotels/${propertyId}`);
  expect(link.props.target).toBe("_blank");
  expect(link.props.rel).toBe("noopener noreferrer");
  expect(mocks.submit).not.toHaveBeenCalled();
});
