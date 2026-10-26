import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BookingPublicationOperation,
  type ReadyBookingPublicationEvidence,
} from "@vayada/domain-booking";
import { createProductReadinessResult } from "@vayada/domain-hotels";

import {
  createBookingPublicationRefresh,
  startBookingPublicationWorker,
  type BookingPublicationWorker,
} from "./bookingPublicationProductionRuntime.js";

describe("Booking publication production worker", () => {
  let worker: BookingPublicationWorker | undefined;

  afterEach(async () => {
    await worker?.close();
    vi.useRealTimers();
  });

  it("starts immediately, stays single-flight, and drains before closing", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const runRetryBatch = vi.fn(
      () =>
        new Promise<{ processed: number; succeeded: number; failed: number; exhausted: number }>(
          (resolve) => {
            finish = () => resolve({ processed: 1, succeeded: 1, failed: 0, exhausted: 0 });
          },
        ),
    );
    worker = startBookingPublicationWorker({
      projector: { projectPending: vi.fn(), runRetryBatch },
      workerId: "worker-1",
      warn: vi.fn(),
      intervalMs: 10,
    });
    expect(runRetryBatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30);
    expect(runRetryBatch).toHaveBeenCalledOnce();

    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish?.();
    await closing;
    await vi.advanceTimersByTimeAsync(30);
    expect(runRetryBatch).toHaveBeenCalledOnce();
  });

  it("reports failed batches and rejected worker calls without stopping the timer", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const runRetryBatch = vi
      .fn()
      .mockResolvedValueOnce({ processed: 1, succeeded: 0, failed: 1, exhausted: 1 })
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue({ processed: 0, succeeded: 0, failed: 0, exhausted: 0 });
    worker = startBookingPublicationWorker({
      projector: { projectPending: vi.fn(), runRetryBatch },
      workerId: "worker-2",
      warn,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(runRetryBatch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      { failed: 1, exhausted: 1 },
      "Booking publication worker completed with failures",
    );
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Booking publication worker failed",
    );
  });
});

describe("Booking publication refresh", () => {
  it("accepts a pending operation when the background worker leased it first", async () => {
    const propertyId = "22222222-2222-4222-8222-222222222222";
    const readiness = await readyEvidence(propertyId);
    const pending: BookingPublicationOperation = {
      operationId: "33333333-3333-4333-8333-333333333333",
      propertyId,
      status: "pending",
      expectedActiveContentRevisionId: null,
      resultContentRevisionId: null,
      failureCode: null,
      requestedAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      completedAt: null,
    };
    const projectPending = vi.fn().mockResolvedValue({
      processed: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
    });
    const refresh = createBookingPublicationRefresh({
      readinessProvider: { getBookingReadiness: vi.fn().mockResolvedValue(readiness) },
      projection: { getActive: vi.fn().mockResolvedValue(null) },
      repository: {
        requestPublication: vi.fn().mockResolvedValue({ ok: true, operation: pending }),
        getPublicationStatus: vi.fn().mockResolvedValue(pending),
      },
      projector: { projectPending },
    });

    await expect(
      refresh({
        organizationId: "11111111-1111-4111-8111-111111111111",
        propertyId,
        actorUserId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "refresh-1",
        audit: { requestId: "request-1", source: "booking-admin" },
      }),
    ).resolves.toEqual(pending);
    expect(projectPending).toHaveBeenCalledWith({ propertyId });
  });

  it("never makes a page public from a live-only refresh (VAY-2129)", async () => {
    const propertyId = "22222222-2222-4222-8222-222222222222";
    const getBookingReadiness = vi.fn();
    const requestPublication = vi.fn();
    const refresh = createBookingPublicationRefresh({
      readinessProvider: { getBookingReadiness },
      projection: { getActive: vi.fn().mockResolvedValue(null) },
      repository: { requestPublication, getPublicationStatus: vi.fn() },
      projector: { projectPending: vi.fn() },
    });

    await expect(
      refresh({
        organizationId: "11111111-1111-4111-8111-111111111111",
        propertyId,
        actorUserId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "refresh-2",
        audit: { requestId: "request-2", source: "booking-admin" },
        onlyIfLive: true,
      }),
    ).resolves.toBeNull();
    expect(getBookingReadiness).not.toHaveBeenCalled();
    expect(requestPublication).not.toHaveBeenCalled();
  });

  it("waits for another publication of a live page and asks again with a new key (VAY-2344)", async () => {
    const propertyId = "22222222-2222-4222-8222-222222222222";
    const done: BookingPublicationOperation = {
      operationId: "33333333-3333-4333-8333-333333333333",
      propertyId,
      status: "succeeded",
      expectedActiveContentRevisionId: "55555555-5555-4555-8555-555555555555",
      resultContentRevisionId: "66666666-6666-4666-8666-666666666666",
      failureCode: null,
      requestedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:01.000Z",
      completedAt: "2026-10-25T00:00:01.000Z",
    };
    const getActive = vi
      .fn()
      .mockResolvedValueOnce({ revisionId: "44444444-4444-4444-8444-444444444444" })
      .mockResolvedValue({ revisionId: "55555555-5555-4555-8555-555555555555" });
    const requestPublication = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "publication_in_progress" } })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "active_content_revision_conflict",
          currentActiveContentRevisionId: "55555555-5555-4555-8555-555555555555",
        },
      })
      .mockResolvedValueOnce({ ok: true, operation: { ...done, status: "pending" } });
    const wait = vi.fn(async (_ms: number) => undefined);
    const refresh = createBookingPublicationRefresh(
      {
        readinessProvider: {
          getBookingReadiness: vi.fn().mockResolvedValue(await readyEvidence(propertyId)),
        },
        projection: { getActive },
        repository: { requestPublication, getPublicationStatus: vi.fn().mockResolvedValue(done) },
        projector: { projectPending: vi.fn().mockResolvedValue({}) },
      },
      wait,
    );

    await expect(
      refresh({
        organizationId: "11111111-1111-4111-8111-111111111111",
        propertyId,
        actorUserId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "req-save",
        audit: { requestId: "req-save", source: "hotel_setup" },
        onlyIfLive: true,
      }),
    ).resolves.toEqual(done);
    expect(wait.mock.calls).toEqual([[1_000], [2_000]]);
    expect(
      requestPublication.mock.calls.map(([command]) => [
        command.idempotencyKey,
        command.expectedActiveContentRevisionId,
      ]),
    ).toEqual([
      ["req-save", "44444444-4444-4444-8444-444444444444"],
      ["req-save:retry-1", "55555555-5555-4555-8555-555555555555"],
      ["req-save:retry-2", "55555555-5555-4555-8555-555555555555"],
    ]);
  });

  it('never waits on "Publish booking page", and gives up after three retries', async () => {
    const propertyId = "22222222-2222-4222-8222-222222222222";
    const requestPublication = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: "publication_in_progress" } });
    const wait = vi.fn(async (_ms: number) => undefined);
    const refresh = createBookingPublicationRefresh(
      {
        readinessProvider: {
          getBookingReadiness: vi.fn().mockResolvedValue(await readyEvidence(propertyId)),
        },
        projection: {
          getActive: vi
            .fn()
            .mockResolvedValue({ revisionId: "44444444-4444-4444-8444-444444444444" }),
        },
        repository: { requestPublication, getPublicationStatus: vi.fn() },
        projector: { projectPending: vi.fn() },
      },
      wait,
    );
    const input = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      propertyId,
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "req-publish",
      audit: { requestId: "req-publish", source: "booking-admin" },
    };

    await expect(refresh(input)).rejects.toThrow("publication_in_progress");
    expect(wait).not.toHaveBeenCalled();
    await expect(refresh({ ...input, onlyIfLive: true })).rejects.toThrow(
      "publication_in_progress",
    );
    expect(wait.mock.calls).toEqual([[1_000], [2_000], [4_000]]);
    expect(requestPublication).toHaveBeenCalledTimes(5);
  });

  it("retries a failed readiness read on a live page, and names what blocks it (VAY-2344)", async () => {
    const propertyId = "22222222-2222-4222-8222-222222222222";
    const failure = {
      outcome: "provider_failure" as const,
      contractVersion: "onboarding-product-readiness.v1" as const,
      propertyId,
      product: "booking" as const,
      status: "error" as const,
      error: {
        kind: "system_error" as const,
        errorSource: "system" as const,
        code: "owner_read_failed",
        message: "Owner evidence is unavailable.",
        retryable: true as const,
      },
      evaluatedAt: "2026-10-25T00:00:00.000Z",
    };
    const done = { operationId: "33333333-3333-4333-8333-333333333333", status: "succeeded" };
    const getBookingReadiness = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValue(await readyEvidence(propertyId));
    const wait = vi.fn(async (_ms: number) => undefined);
    const refresh = createBookingPublicationRefresh(
      {
        readinessProvider: { getBookingReadiness },
        projection: {
          getActive: vi
            .fn()
            .mockResolvedValue({ revisionId: "44444444-4444-4444-8444-444444444444" }),
        },
        repository: {
          requestPublication: vi.fn().mockResolvedValue({ ok: true, operation: done }),
          getPublicationStatus: vi.fn().mockResolvedValue(done),
        },
        projector: { projectPending: vi.fn().mockResolvedValue({}) },
      },
      wait,
    );
    const input = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      propertyId,
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "req-save",
      audit: { requestId: "req-save", source: "hotel_setup" },
    };

    await expect(refresh({ ...input, onlyIfLive: true })).resolves.toEqual(done);
    expect(wait.mock.calls).toEqual([[1_000]]);
    // "Publish booking page" reports it at once, with the codes only.
    getBookingReadiness.mockResolvedValueOnce(failure);
    await expect(refresh(input)).rejects.toThrow(
      "Booking publication readiness is incomplete. (provider_failure: system/owner_read_failed)",
    );
  });

  it("asks again after a deadlock with another refresh, only for a live page (VAY-2344)", async () => {
    const propertyId = "22222222-2222-4222-8222-222222222222";
    const done = { operationId: "33333333-3333-4333-8333-333333333333", status: "succeeded" };
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const requestPublication = vi
      .fn()
      .mockRejectedValueOnce(deadlock)
      .mockResolvedValue({ ok: true, operation: done });
    const wait = vi.fn(async (_ms: number) => undefined);
    const refresh = createBookingPublicationRefresh(
      {
        readinessProvider: {
          getBookingReadiness: vi.fn().mockResolvedValue(await readyEvidence(propertyId)),
        },
        projection: {
          getActive: vi
            .fn()
            .mockResolvedValue({ revisionId: "44444444-4444-4444-8444-444444444444" }),
        },
        repository: { requestPublication, getPublicationStatus: vi.fn().mockResolvedValue(done) },
        projector: { projectPending: vi.fn().mockResolvedValue({}) },
      },
      wait,
    );
    const input = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      propertyId,
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "req-save",
      audit: { requestId: "req-save", source: "hotel_setup" },
    };

    await expect(refresh({ ...input, onlyIfLive: true })).resolves.toEqual(done);
    expect(wait.mock.calls).toEqual([[1_000]]);
    expect(requestPublication.mock.calls.map(([command]) => command.idempotencyKey)).toEqual([
      "req-save",
      "req-save:retry-1",
    ]);
    requestPublication.mockRejectedValueOnce(deadlock);
    await expect(refresh(input)).rejects.toBe(deadlock);
  });
});

async function readyEvidence(propertyId: string): Promise<ReadyBookingPublicationEvidence> {
  return (await createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "booking",
    status: "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [
        {
          ownerDomain: "booking",
          entityType: "booking_settings",
          entityId: propertyId,
          revision: "booking-settings:4",
        },
      ],
    },
    groups: [
      {
        groupId: "booking.guest_experience",
        status: "ready",
        steps: [
          {
            owningStepId: "guest_experience",
            status: "ready",
            entities: [
              {
                source: {
                  ownerDomain: "booking",
                  entityType: "booking_settings",
                  entityId: propertyId,
                  revision: "booking-settings:4",
                },
                status: "ready",
                blockers: [],
              },
            ],
          },
        ],
      },
    ],
    evaluatedAt: "2026-09-03T00:00:00.000Z",
  })) as ReadyBookingPublicationEvidence;
}
