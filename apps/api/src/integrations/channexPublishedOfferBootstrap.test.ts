import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const primitives = vi.hoisted(() => ({
  read: vi.fn(),
  prepare: vi.fn(),
  record: vi.fn(),
  configure: vi.fn(),
}));
vi.mock("../domains/replacementPricingOfferOwners.js", () => ({
  readPublishedPricingForChannexJob: primitives.read,
  prepareChannexOfferDispatch: primitives.prepare,
  recordRetainedChannexOfferCreate: primitives.record,
  retainChannexOfferConfiguration: primitives.configure,
}));

import { bootstrapPublishedChannexOffer } from "./channexPublishedOfferBootstrap.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const roomTypeId = "22222222-2222-4222-8222-222222222222";
const offerId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const job = {
  jobId,
  propertyId,
  attemptNumber: 1,
  maxAttempts: 3,
  correlationId: null,
  input: {
    commandId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: "saved-offer-test",
    operationType: "provision" as const,
    publishedOffer: { roomTypeId, offerId, publicationRevision: 1, primaryOccupancy: 2 },
  },
};
const ports = { get: vi.fn(), create: vi.fn() };

describe("published Channex offer bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primitives.read.mockResolvedValue({
      kind: "available",
      publication: {
        revision: 1,
        rooms: [{ roomTypeId, offers: [{ id: offerId }] }],
      },
    });
  });

  it("uses retained creation evidence on retry without another provider create", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ attemptId, state: "unresolved" }] }),
    } as unknown as Pool;
    primitives.record.mockResolvedValue({ kind: "identified" });
    primitives.configure.mockResolvedValue({ kind: "configuration_retained" });

    await expect(bootstrapPublishedChannexOffer(pool, job, "worker", ports)).resolves.toEqual({
      kind: "ready",
    });
    expect(primitives.record).toHaveBeenCalledWith(
      pool,
      { jobId, attemptNumber: 1, workerId: "worker" },
      { roomTypeId, offerId, operationKey: jobId, primaryOccupancy: 2 },
      attemptId,
    );
    expect(primitives.prepare).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("returns durable progress after the first create receipt is saved", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    const dispatch = vi.fn().mockResolvedValue({ kind: "retained", attemptId });
    primitives.prepare.mockResolvedValue({ kind: "prepared", dispatch });

    await expect(bootstrapPublishedChannexOffer(pool, job, "worker", ports)).resolves.toEqual({
      kind: "creation_retained",
      attemptId,
    });
    expect(dispatch).toHaveBeenCalledWith({ getRoom: ports.get, create: ports.create });
  });

  it("recognizes an already activated matching offer after worker completion crashes", async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ attemptId, state: "identified", completed: true }] }),
    } as unknown as Pool;
    await expect(bootstrapPublishedChannexOffer(pool, job, "worker", ports)).resolves.toEqual({
      kind: "ready",
    });
    expect(primitives.prepare).not.toHaveBeenCalled();
    expect(primitives.configure).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("holds a stale publication before looking for or creating a rate", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    primitives.read.mockResolvedValue({
      kind: "available",
      publication: { revision: 2, rooms: [] },
    });
    await expect(bootstrapPublishedChannexOffer(pool, job, "worker", ports)).resolves.toEqual({
      kind: "unavailable",
      reason: "publication_changed",
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(primitives.prepare).not.toHaveBeenCalled();
  });
});
