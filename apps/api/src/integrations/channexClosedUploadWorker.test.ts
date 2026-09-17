import { describe, expect, it, vi } from "vitest";
import { createChannexManagementProvider } from "./channexManagement.js";
import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";

const job: ChannexManagementJob = {
  jobId: "job",
  propertyId: "property",
  attemptNumber: 1,
  maxAttempts: 5,
  correlationId: null,
  input: { operationType: "sync_ari", commandId: "command", idempotencyKey: "key" },
};
function setup() {
  const dispatchClosedUpload = vi.fn(async () => ({ kind: "no_closed_upload" as const }));
  const reconcileClosedUploads = vi.fn(async () => ({
    kind: "pending_uploads_reconciled" as const,
    count: 0,
  }));
  const reconcileRoomAvailability = vi.fn(async () => ({
    kind: "pending_availability_reconciled" as const,
    count: 0,
  }));
  const prepareRoomAvailability = vi.fn(async () => ({
    kind: "unavailable" as const,
    reason: "room_availability_coverage_unavailable",
  }));
  const plan = vi.fn(async () => ({ requests: [] }));
  return {
    dispatchClosedUpload,
    reconcileClosedUploads,
    reconcileRoomAvailability,
    prepareRoomAvailability,
    plan,
    config: {
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      plans: { plan },
      dispatchClosedUpload,
      reconcileClosedUploads,
      reconcileRoomAvailability,
      prepareRoomAvailability,
    },
  };
}
describe("closed upload worker gates", () => {
  it("never treats unavailable room coverage as full sync success", async () => {
    const f = setup();
    expect(
      await createChannexManagementProvider(f.config).execute(job, { workerId: "worker" }),
    ).toMatchObject({ ok: false, code: "invalid_state" });
    expect(f.dispatchClosedUpload).toHaveBeenCalledOnce();
    expect(f.plan).not.toHaveBeenCalled();
  });
  it("excludes restrictions-only jobs from initial price dispatch", async () => {
    const f = setup();
    await createChannexManagementProvider(f.config).execute(
      { ...job, input: { ...job.input, restrictionsOnly: true } },
      { workerId: "worker" },
    );
    expect(f.dispatchClosedUpload).not.toHaveBeenCalled();
    expect(f.reconcileRoomAvailability).not.toHaveBeenCalled();
    expect(f.prepareRoomAvailability).not.toHaveBeenCalled();
  });
  it.each(["disabled", "worker-missing", "reconciliation-missing"])(
    "cannot send with %s",
    async (mode) => {
      const f = setup();
      const provider = createChannexManagementProvider({
        ...f.config,
        canSyncAri: mode !== "disabled",
        reconcileClosedUploads:
          mode === "reconciliation-missing" ? undefined : f.reconcileClosedUploads,
      });
      expect(
        await provider.execute(job, mode === "worker-missing" ? undefined : { workerId: "worker" }),
      ).toMatchObject({ ok: false });
      expect(f.dispatchClosedUpload).not.toHaveBeenCalled();
    },
  );
  it("does not send after reconciliation fails and does not expose provider secrets", async () => {
    const f = setup();
    f.reconcileClosedUploads.mockRejectedValue(new Error("secret-token"));
    const result = await createChannexManagementProvider(f.config).execute(job, {
      workerId: "worker",
    });
    expect(result).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(f.dispatchClosedUpload).not.toHaveBeenCalled();
  });
  it("reconciles retained availability before sending one scoped room/day", async () => {
    const f = setup(),
      order: string[] = [],
      reconcileRoomAvailability = vi.fn(async (_lease, get) => {
        order.push("reconcile");
        await get(
          "/api/v1/tasks/00000000-0000-4000-8000-000000000001",
          new AbortController().signal,
        );
        return { kind: "pending_availability_reconciled" as const, count: 1 };
      }),
      prepareRoomAvailability = vi.fn(async () => ({
        kind: "prepared" as const,
        attemptId: "availability-attempt",
        roomTypeId: "room",
        date: "2026-09-17",
        dispatch: async (post: (request: never, signal: AbortSignal) => Promise<Response>) => {
          order.push("dispatch");
          await post(
            {
              method: "POST",
              path: "/api/v1/availability",
              body: { values: [{ date_from: "2026-09-17", availability: 2 }] },
            } as never,
            new AbortController().signal,
          );
          return { kind: "retained" as const, attemptId: "availability-attempt" };
        },
      })),
      fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        init?.method === "GET"
          ? Response.json({ data: { type: "task" } })
          : Response.json({ data: [] }),
      );
    const result = await createChannexManagementProvider({
      ...f.config,
      fetch: fetcher,
      reconcileRoomAvailability,
      prepareRoomAvailability,
    }).execute(job, { workerId: "worker" });
    expect(result).toEqual({
      ok: false,
      code: "availability_upload_retained",
      attemptId: "availability-attempt",
    });
    expect(order).toEqual(["reconcile", "dispatch"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toEqual(
      new URL("https://staging.channex.io/api/v1/availability"),
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(f.plan).not.toHaveBeenCalled();
  });
  it("persists a pending availability receipt before granting continuation", async () => {
    const f = setup(),
      persist = vi.fn(async () => ({ kind: "retained" as const, receiptId: "receipt" }));
    const result = await createChannexManagementProvider({
      ...f.config,
      reconcileRoomAvailability: async () => ({
        kind: "pending_availability_reconciled" as const,
        count: 0,
      }),
      prepareRoomAvailability: async () => ({
        kind: "prepared" as const,
        attemptId: "pending-attempt",
        roomTypeId: "room",
        date: "2026-09-17",
        dispatch: async () => ({
          kind: "receipt_pending" as const,
          attemptId: "pending-attempt",
          persist,
        }),
      }),
    }).execute(job, { workerId: "worker" });
    expect(persist).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      code: "availability_upload_retained",
      attemptId: "pending-attempt",
    });
  });
  it("continues the existing plan only when availability coverage is current", async () => {
    const f = setup();
    const result = await createChannexManagementProvider({
      ...f.config,
      reconcileRoomAvailability: async () => ({
        kind: "pending_availability_reconciled" as const,
        count: 0,
      }),
      prepareRoomAvailability: async () => ({
        kind: "room_availability_current" as const,
        from: "2026-09-17",
        through: "2026-09-17",
        roomCount: 1,
        dayCount: 1,
      }),
    }).execute(job, { workerId: "worker" });
    expect(result).toMatchObject({ ok: true });
    expect(f.plan).toHaveBeenCalledOnce();
  });
  it("finishes through verified offer activation without running the legacy plan", async () => {
    const f = setup(),
      activatePublishedOffers = vi.fn(async () => ({
        kind: "all_targets_active" as const,
        count: 2,
      }));
    const result = await createChannexManagementProvider({
      ...f.config,
      prepareRoomAvailability: async () => ({
        kind: "room_availability_current" as const,
        from: "2026-09-17",
        through: "2026-09-17",
        roomCount: 1,
        dayCount: 1,
      }),
      activatePublishedOffers,
    }).execute(job, { workerId: "worker" });
    expect(result).toEqual({ ok: true });
    expect(activatePublishedOffers).toHaveBeenCalledOnce();
    expect(f.plan).not.toHaveBeenCalled();
  });
  it("fails closed when a published target cannot activate", async () => {
    const f = setup();
    const result = await createChannexManagementProvider({
      ...f.config,
      prepareRoomAvailability: async () => ({
        kind: "room_availability_current" as const,
        from: "2026-09-17",
        through: "2026-09-17",
        roomCount: 1,
        dayCount: 1,
      }),
      activatePublishedOffers: async () => ({
        kind: "unavailable" as const,
        reason: "initial_ari_incomplete",
      }),
    }).execute(job, { workerId: "worker" });
    expect(result).toMatchObject({ ok: false, code: "invalid_state" });
    expect(f.plan).not.toHaveBeenCalled();
  });
  it("keeps pending published target activation retryable", async () => {
    const f = setup();
    const result = await createChannexManagementProvider({
      ...f.config,
      prepareRoomAvailability: async () => ({
        kind: "room_availability_current" as const,
        from: "2026-09-17",
        through: "2026-09-17",
        roomCount: 1,
        dayCount: 1,
      }),
      activatePublishedOffers: async () => ({
        kind: "unavailable" as const,
        reason: "target_activation_pending",
      }),
    }).execute(job, { workerId: "worker" });
    expect(result).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(f.plan).not.toHaveBeenCalled();
  });
  it("fails closed without provider IO for unavailable or unpaired availability hooks", async () => {
    const f = setup(),
      fetcher = vi.fn();
    const unavailable = await createChannexManagementProvider({
      ...f.config,
      fetch: fetcher,
      reconcileRoomAvailability: async () => ({
        kind: "pending_availability_reconciled" as const,
        count: 0,
      }),
      prepareRoomAvailability: async () => ({
        kind: "unavailable" as const,
        reason: "room_availability_coverage_unavailable",
      }),
    }).execute(job, { workerId: "worker" });
    expect(unavailable).toMatchObject({ ok: false, code: "invalid_state" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.plan).not.toHaveBeenCalled();
    expect(
      await createChannexManagementProvider({
        ...f.config,
        reconcileRoomAvailability: async () => ({
          kind: "pending_availability_reconciled" as const,
          count: 0,
        }),
        prepareRoomAvailability: undefined,
      }).execute(job, { workerId: "worker" }),
    ).toMatchObject({ ok: false, code: "invalid_state" });
  });
  it("returns retryable failure for a bounded availability reconciliation continuation", async () => {
    const f = setup(),
      prepareRoomAvailability = vi.fn();
    expect(
      await createChannexManagementProvider({
        ...f.config,
        reconcileRoomAvailability: async () => ({
          kind: "unavailable" as const,
          reason: "availability_reconciliation_batch_pending",
        }),
        prepareRoomAvailability,
      }).execute(job, { workerId: "worker" }),
    ).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(prepareRoomAvailability).not.toHaveBeenCalled();
  });
  it("does not run availability hooks without the complete pricing dependency bundle", async () => {
    const f = setup(),
      reconcileRoomAvailability = vi.fn(),
      prepareRoomAvailability = vi.fn(),
      fetcher = vi.fn();
    expect(
      await createChannexManagementProvider({
        apiBaseUrl: f.config.apiBaseUrl,
        apiKey: f.config.apiKey,
        plans: { plan: f.plan },
        fetch: fetcher,
        reconcileRoomAvailability,
        prepareRoomAvailability,
      }).execute(job, { workerId: "worker" }),
    ).toMatchObject({ ok: false, code: "invalid_state" });
    expect(reconcileRoomAvailability).not.toHaveBeenCalled();
    expect(prepareRoomAvailability).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.plan).not.toHaveBeenCalled();
  });
  it("rejects unrelated Channex reconciliation paths before provider fetch", async () => {
    const f = setup(),
      fetcher = vi.fn(),
      prepareRoomAvailability = vi.fn();
    const result = await createChannexManagementProvider({
      ...f.config,
      fetch: fetcher,
      reconcileRoomAvailability: async (_lease, get) => {
        await get(
          "/api/v1/channels/00000000-0000-4000-8000-000000000001",
          new AbortController().signal,
        );
        return { kind: "pending_availability_reconciled" as const, count: 0 };
      },
      prepareRoomAvailability,
    }).execute(job, { workerId: "worker" });
    expect(result).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(prepareRoomAvailability).not.toHaveBeenCalled();
  });
  it("allows exact property and room preflight reads through the provider adapter", async () => {
    const f = setup(),
      fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0]) => Response.json({ data: {} }));
    const result = await createChannexManagementProvider({
      ...f.config,
      fetch: fetcher,
      reconcileRoomAvailability: async (_lease, get) => {
        const signal = new AbortController().signal;
        await get("/api/v1/properties/00000000-0000-4000-8000-000000000001", signal);
        await get("/api/v1/room_types/00000000-0000-4000-8000-000000000002", signal);
        return { kind: "pending_availability_reconciled" as const, count: 0 };
      },
      prepareRoomAvailability: async () => ({
        kind: "room_availability_current" as const,
        from: "2026-09-17",
        through: "2026-09-17",
        roomCount: 1,
        dayCount: 1,
      }),
    }).execute(job, { workerId: "worker" });
    expect(result).toMatchObject({ ok: true });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/v1/properties/00000000-0000-4000-8000-000000000001",
      "/api/v1/room_types/00000000-0000-4000-8000-000000000002",
    ]);
  });
  it.each(["closed-pair", "closed-reconcile-only"])(
    "rejects a %s bundle before any hook or provider side effect",
    async (mode) => {
      const f = setup(),
        fetcher = vi.fn();
      expect(
        await createChannexManagementProvider({
          apiBaseUrl: f.config.apiBaseUrl,
          apiKey: f.config.apiKey,
          plans: { plan: f.plan },
          fetch: fetcher,
          reconcileClosedUploads: f.reconcileClosedUploads,
          dispatchClosedUpload: mode === "closed-pair" ? f.dispatchClosedUpload : undefined,
        }).execute(job, { workerId: "worker" }),
      ).toMatchObject({ ok: false, code: "invalid_state" });
      expect(f.reconcileClosedUploads).not.toHaveBeenCalled();
      expect(f.dispatchClosedUpload).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.plan).not.toHaveBeenCalled();
    },
  );
});
