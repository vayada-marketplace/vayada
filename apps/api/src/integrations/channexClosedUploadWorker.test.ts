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
  const plan = vi.fn(async () => ({ requests: [] }));
  return {
    dispatchClosedUpload,
    reconcileClosedUploads,
    plan,
    config: {
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      plans: { plan },
      dispatchClosedUpload,
      reconcileClosedUploads,
    },
  };
}
describe("closed upload worker gates", () => {
  it("never treats closed coverage alone as full sync success", async () => {
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
});
