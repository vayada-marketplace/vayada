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

it.each(["booking_unmapped_room", "booking_unmapped_rate", "disconnected_channel"])(
  "requires correction confirmation and keeps failed recovery actionable: %s",
  async (eventType) => {
    vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
    vi.mocked(channexService.alertAction).mockReset();
    let alert = {
      id: "correction",
      eventType,
      impact: {},
      firstOccurredAt: "2026-09-14",
      lastOccurredAt: "2026-09-14",
      acknowledgedAt: null,
      resolvedAt: null,
      recoveryRound: 0,
      occurrences: 1,
      recovery: [],
    } as ChannexAlert;
    vi.mocked(channexService.getAlerts).mockImplementation(async () => [alert]);
    const snapshot = {
      sync: { booking: { retryAfter: null }, ari: { retryAfter: null } },
      capabilityModes: { bookingSync: "mutating", ariSync: "mutating", iframe: "mutating" },
    } as ChannexSnapshot;
    const openSettings = vi.fn(async () => {});
    let view!: ReturnType<typeof create>;
    const button = (name: string) =>
      view.root.findAllByType("button").find((b) => b.children.join("") === name)!;
    const text = () => JSON.stringify(view.toJSON());
    try {
      await act(async () => {
        view = create(createElement(OperationalAlerts, { snapshot, openSettings }));
      });
      expect(button("Retry recovery").props.disabled).toBe(true);
      await act(async () => {
        button("Open channel settings").props.onClick();
      });
      expect(openSettings).toHaveBeenCalledOnce();
      expect(button("Retry recovery").props.disabled).toBe(true);
      await act(async () => {
        view.root.findByType("input").props.onChange({ target: { checked: true } });
      });
      expect(button("Retry recovery").props.disabled).toBe(false);
      vi.mocked(channexService.alertAction).mockRejectedValueOnce(new Error("rejected"));
      await act(async () => {
        button("Retry recovery").props.onClick();
      });
      expect(text()).toContain("The request could not be accepted.");
      expect(text()).not.toContain('"Recovery verified"');
      expect(button("Retry recovery").props.disabled).toBe(false);
      vi.mocked(channexService.alertAction).mockImplementationOnce(async () => {
        alert = {
          ...alert,
          recoveryRound: 1,
          recovery: [
            {
              status: "pending",
              verified: false,
              attemptsMade: 1,
              maxAttempts: 5,
              retryAfter: "2026-09-14T12:00:00Z",
            },
          ],
        };
      });
      await act(async () => {
        button("Retry recovery").props.onClick();
      });
      expect(channexService.alertAction).toHaveBeenLastCalledWith("correction", "recover", 0);
      expect(text()).toContain("Recovery is running; this alert remains open.");
      expect(button("Retry recovery").props.disabled).toBe(true);
      alert = {
        ...alert,
        recoveryRound: 3,
        recovery: [
          {
            status: "dead_lettered",
            verified: false,
            attemptsMade: 5,
            maxAttempts: 5,
            retryAfter: null,
          },
        ],
      };
      await act(async () => {
        button("Refresh alerts").props.onClick();
      });
      expect(text()).toContain("Recovery limit reached. Contact support with alert reference");
      expect(text()).toContain("correction");
      expect(button("Retry recovery").props.disabled).toBe(true);
      expect(text()).not.toContain('"Recovery verified"');
    } finally {
      if (view) act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("waits for both reconnection jobs and verified scope before showing resolution", async () => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  const success = {
    status: "succeeded",
    verified: true,
    attemptsMade: 1,
    maxAttempts: 5,
    retryAfter: null,
  };
  let alert = {
    id: "both-jobs",
    eventType: "disconnected_channel",
    impact: {},
    firstOccurredAt: "2026-09-14",
    lastOccurredAt: "2026-09-14",
    acknowledgedAt: null,
    resolvedAt: null,
    recoveryRound: 1,
    occurrences: 1,
    recovery: [success, { ...success, status: "pending", verified: false }],
  } as ChannexAlert;
  vi.mocked(channexService.getAlerts).mockImplementation(async () => [alert]);
  const snapshot = {
    sync: { booking: { retryAfter: null }, ari: { retryAfter: null } },
    capabilityModes: { bookingSync: "mutating", ariSync: "mutating" },
  } as ChannexSnapshot;
  let view!: ReturnType<typeof create>;
  const text = () => JSON.stringify(view.toJSON());
  const refresh = async () => {
    await act(async () => {
      view.root
        .findAllByType("button")
        .find((b) => b.children.join("") === "Refresh alerts")!
        .props.onClick();
    });
  };
  try {
    await act(async () => {
      view = create(createElement(OperationalAlerts, { snapshot, openSettings: async () => {} }));
    });
    expect(text()).toContain("Recovery is running; this alert remains open.");
    expect(text()).not.toContain('"Recovery verified"');
    alert = { ...alert, recovery: [success, { ...success, verified: false }] };
    await refresh();
    expect(text()).toContain("The affected scope could not be verified.");
    expect(text()).not.toContain('"Recovery verified"');
    alert = { ...alert, resolvedAt: "2026-09-14T12:00:00Z", recovery: [success, success] };
    await refresh();
    expect(text()).toContain('"Recovery verified"');
    expect(text()).toContain("Recovery completed and provider evidence was checked.");
    expect(
      view.root.findAllByType("button").some((b) => b.children.join("") === "Retry recovery"),
    ).toBe(false);
  } finally {
    if (view) act(() => view.unmount());
    vi.unstubAllGlobals();
  }
});
