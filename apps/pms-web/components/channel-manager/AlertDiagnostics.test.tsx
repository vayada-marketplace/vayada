import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { AlertDiagnostics } from "./AlertDiagnostics";
import { channexService, type ChannexAlertDiagnostics } from "@/services/channex";
vi.mock("@/services/channex", () => ({ channexService: { getAlertDiagnostics: vi.fn() } }));
const result: ChannexAlertDiagnostics = {
  alertId: "alert",
  recoveryRound: 1,
  observedAt: "2026-09-17T10:00:00Z",
  newerOccurrence: true,
  linkedJobCount: 2,
  latestReceipt: null,
  recovery: [
    {
      jobId: "job",
      operation: "sync_ari",
      status: "succeeded",
      attemptsMade: 1,
      updatedAt: "2026-09-17T09:00:00Z",
      failure: null,
    },
  ],
};
it("loads on expansion, explains historical and missing evidence, and supports retry", async () => {
  vi.mocked(channexService.getAlertDiagnostics).mockReset().mockResolvedValue(result);
  const view = create(
    createElement(AlertDiagnostics, { propertyId: "property", alertId: "alert", round: 1 }),
  );
  const text = () => JSON.stringify(view.toJSON());
  try {
    expect(channexService.getAlertDiagnostics).not.toHaveBeenCalled();
    await act(async () =>
      view.root.findByType("details").props.onToggle({ currentTarget: { open: true } }),
    );
    expect(channexService.getAlertDiagnostics).toHaveBeenCalledWith("property", "alert");
    expect(text()).toContain("Local job completed");
    expect(text()).toContain("These do not confirm current delivery");
    expect(text()).toContain("Some linked recovery evidence is unavailable");
    expect(text()).toContain("Receipt evidence is unavailable");
    expect(text()).toContain("newer occurrence");
    vi.mocked(channexService.getAlertDiagnostics).mockRejectedValueOnce(
      new Error("provider secret"),
    );
    await act(async () => view.root.findByType("button").props.onClick());
    expect(text()).toContain("Diagnostic details are unavailable");
    expect(text()).not.toContain("provider secret");
    expect(text()).not.toContain("Local job completed");
    await act(async () => view.root.findByType("button").props.onClick());
    expect(text()).toContain("Local job completed");
  } finally {
    act(() => view.unmount());
  }
});
it("rejects another recovery round and discards results after collapse", async () => {
  vi.mocked(channexService.getAlertDiagnostics)
    .mockReset()
    .mockResolvedValue({ ...result, recoveryRound: 0 });
  const view = create(
    createElement(AlertDiagnostics, { propertyId: "property", alertId: "alert", round: 1 }),
  );
  try {
    await act(async () =>
      view.root.findByType("details").props.onToggle({ currentTarget: { open: true } }),
    );
    expect(JSON.stringify(view.toJSON())).toContain("Diagnostic details are unavailable");
    let finish!: (value: ChannexAlertDiagnostics) => void;
    vi.mocked(channexService.getAlertDiagnostics).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => view.root.findByType("button").props.onClick());
    await act(async () =>
      view.root.findByType("details").props.onToggle({ currentTarget: { open: false } }),
    );
    await act(async () => finish(result));
    expect(JSON.stringify(view.toJSON())).not.toContain("Local job completed");
  } finally {
    act(() => view.unmount());
  }
});
