import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { OperationalAlerts } from "./OperationalAlerts";
import { channexService, type ChannexAlert, type ChannexSnapshot } from "@/services/channex";
vi.mock("@/services/channex", () => ({
  channexService: { getAlerts: vi.fn(), alertAction: vi.fn() },
}));
it("enables only the approved missing-ACK incident and sends only alert/round authority", async () => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  const alert = {
    id: "approved",
    eventType: "non_acked_booking",
    impact: {},
    firstOccurredAt: "2026-09-14",
    lastOccurredAt: "2026-09-14",
    acknowledgedAt: null,
    resolvedAt: null,
    recoveryRound: 0,
    occurrences: 1,
    recovery: [],
    stagingRecoveryAvailable: true,
  } as ChannexAlert;
  vi.mocked(channexService.getAlerts).mockResolvedValue([
    alert,
    { ...alert, id: "unapproved", stagingRecoveryAvailable: false },
  ]);
  const snapshot = {
    sync: { booking: { retryAfter: null }, ari: { retryAfter: null } },
    capabilityModes: { bookingSync: "observe_only", ariSync: "observe_only" },
  } as ChannexSnapshot;
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(createElement(OperationalAlerts, { snapshot, openSettings: async () => {} }));
    });
    const buttons = view.root
      .findAllByType("button")
      .filter((b) => b.children.join("") === "Retry recovery");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.props.disabled).toBe(false);
    expect(buttons[1]!.props.disabled).toBe(true);
    await act(async () => {
      buttons[0]!.props.onClick();
    });
    expect(channexService.alertAction).toHaveBeenCalledWith("approved", "recover", 0);
    expect(snapshot.capabilityModes.bookingSync).toBe("observe_only");
  } finally {
    if (view) act(() => view.unmount());
    vi.unstubAllGlobals();
  }
});
