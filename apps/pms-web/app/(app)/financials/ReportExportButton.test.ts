import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestReportCsv = vi.fn();
const getReportCsv = vi.fn();
vi.mock("@/services/finance/financialReports", () => ({ requestReportCsv, getReportCsv }));
const input = { tab: "dashboard" as const, filters: { asOf: "2026-09-25" } };

async function render(disabled = false) {
  const { ReportExportButton } = await import("./ReportExportButton");
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(ReportExportButton, { propertyId: "hotel-a", input, disabled }));
  });
  return { tree, ReportExportButton };
}
async function click(tree: ReactTestRenderer) {
  await act(async () => {
    await tree.root.findByType("button").props.onClick();
  });
}

describe("ReportExportButton", () => {
  beforeEach(() => {
    requestReportCsv.mockReset().mockResolvedValue({ item: { resourceId: "export-a" } });
    getReportCsv.mockReset().mockResolvedValue({ item: { state: "pending" } });
  });

  it("checks the existing request instead of enqueueing it twice", async () => {
    const { tree } = await render();
    await click(tree);
    getReportCsv.mockResolvedValue({
      item: {
        state: "ready",
        download: {
          url: "https://files.example/report.csv",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    await click(tree);
    expect(requestReportCsv).toHaveBeenCalledTimes(1);
    expect(requestReportCsv.mock.calls[0].slice(0, 2)).toEqual(["hotel-a", input]);
    expect(getReportCsv).toHaveBeenCalledTimes(2);
    expect(tree.root.findByType("a").props.href).toBe("https://files.example/report.csv");
    tree.unmount();
  });

  it("retries ambiguous enqueue errors with the same command key", async () => {
    requestReportCsv.mockRejectedValueOnce(new Error("network"));
    const { tree } = await render();
    await click(tree);
    await click(tree);
    expect(requestReportCsv.mock.calls[0][2]).toBe(requestReportCsv.mock.calls[1][2]);
    tree.unmount();
  });

  it("does not enqueue when the report is unavailable", async () => {
    const { tree } = await render(true);
    await click(tree);
    expect(requestReportCsv).not.toHaveBeenCalled();
    tree.unmount();
  });

  it("ignores an old hotel's response after changing scope", async () => {
    let resolve!: (value: unknown) => void;
    getReportCsv.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { tree, ReportExportButton } = await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = tree.root.findByType("button").props.onClick();
    });
    await act(async () => {
      tree.update(createElement(ReportExportButton, { propertyId: "hotel-b", input }));
    });
    await act(async () => {
      resolve({
        item: {
          state: "ready",
          download: {
            url: "https://files.example/old.csv",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
      await pending;
    });
    expect(tree.root.findAllByType("a")).toHaveLength(0);
    expect(getReportCsv.mock.calls[0][2].aborted).toBe(true);
    await click(tree);
    expect(requestReportCsv.mock.calls[1][0]).toBe("hotel-b");
    tree.unmount();
  });

  it("removes a signed link when it expires without another user action", async () => {
    vi.useFakeTimers();
    try {
      getReportCsv.mockResolvedValue({
        item: {
          state: "ready",
          download: {
            url: "https://files.example/report.csv",
            expiresAt: new Date(Date.now() + 1000).toISOString(),
          },
        },
      });
      const { tree } = await render();
      await click(tree);
      expect(tree.root.findAllByType("a")).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(1001);
      });
      expect(tree.root.findAllByType("a")).toHaveLength(0);
      expect(JSON.stringify(tree.toJSON())).toContain("link expired");
      tree.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show an expired signed download link", async () => {
    getReportCsv.mockResolvedValue({
      item: {
        state: "ready",
        download: {
          url: "https://files.example/expired.csv",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      },
    });
    const { tree } = await render();
    await click(tree);
    expect(tree.root.findAllByType("a")).toHaveLength(0);
    tree.unmount();
  });

  it("allows a new request after a terminal failure", async () => {
    getReportCsv.mockResolvedValueOnce({ item: { state: "failed" } });
    const { tree } = await render();
    await click(tree);
    await click(tree);
    expect(requestReportCsv).toHaveBeenCalledTimes(2);
    expect(requestReportCsv.mock.calls[0][2]).not.toBe(requestReportCsv.mock.calls[1][2]);
    tree.unmount();
  });
});
