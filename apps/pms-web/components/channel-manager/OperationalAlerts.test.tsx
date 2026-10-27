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

// VAY-2108 W1d: the alerts booking intake raises when an OTA booking is refused or lands on closed nights.
it.each([
  ["inventory_not_open", "Open the calendar for those dates"],
  ["operational_mapping_unavailable", "Fix the mapping in channel settings"],
  ["handler_failed", "Something stopped the import."],
])(
  "tells the hotel a %s booking is missing and lets it retry the import",
  async (reason, advice) => {
    vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
    vi.mocked(channexService.alertAction).mockReset();
    vi.mocked(channexService.getAlerts).mockResolvedValue([
      {
        id: "missing",
        eventType: "booking_not_imported",
        impact: {
          bookingId: "chx-booking",
          revisionId: "chx-revision",
          channel: "BookingCom",
          reference: "BDC-4711",
          dateFrom: "2026-12-01",
          dateTo: "2026-12-03",
          roomTypeId: "chx-room",
          errorType: reason,
        },
        firstOccurredAt: "2026-10-27T10:00:00Z",
        lastOccurredAt: "2026-10-27T10:00:00Z",
        acknowledgedAt: null,
        resolvedAt: null,
        recoveryRound: 0,
        occurrences: 0,
        recovery: [],
      } as ChannexAlert,
    ]);
    const snapshot = {
      sync: { booking: { retryAfter: null }, ari: { retryAfter: null } },
      capabilityModes: { bookingSync: "mutating", ariSync: "observe_only", iframe: "mutating" },
    } as ChannexSnapshot;
    let view!: ReturnType<typeof create>;
    try {
      await act(async () => {
        view = create(createElement(OperationalAlerts, { snapshot, openSettings: async () => {} }));
      });
      const text = JSON.stringify(view.toJSON());
      expect(text).toContain("A booking is missing from your PMS");
      expect(text).toContain("Booking.com confirmed this booking, but it is not in your PMS");
      expect(text).toContain(advice);
      expect(text).toContain("BDC-4711");
      expect(text).not.toContain("occurrence");
      const retry = view.root
        .findAllByType("button")
        .find((b) => b.children.join("") === "Retry import")!;
      expect(retry.props.disabled).toBe(false);
      await act(async () => {
        retry.props.onClick();
      });
      expect(channexService.alertAction).toHaveBeenCalledWith("missing", "recover", 0);
    } finally {
      if (view) act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("asks the hotel to check a booking that landed on closed nights, without a retry", async () => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  vi.mocked(channexService.alertAction).mockReset();
  let alert = {
    id: "closed",
    eventType: "booking_on_closed_night",
    impact: {
      bookingId: "chx-booking",
      channel: "Airbnb",
      reference: "HM-42",
      dateFrom: "2026-11-05",
      dateTo: "2026-11-07",
      roomTypeNames: "Garden villa",
      errorType: "inventory_closed",
    },
    firstOccurredAt: "2026-10-27T10:00:00Z",
    lastOccurredAt: "2026-10-27T10:00:00Z",
    acknowledgedAt: null,
    resolvedAt: null,
    recoveryRound: 0,
    occurrences: 0,
    recovery: [],
  } as ChannexAlert;
  vi.mocked(channexService.getAlerts).mockImplementation(async () => [alert]);
  const snapshot = {
    sync: { booking: { retryAfter: null }, ari: { retryAfter: null } },
    capabilityModes: { bookingSync: "mutating", ariSync: "mutating", iframe: "mutating" },
  } as ChannexSnapshot;
  let view!: ReturnType<typeof create>;
  const labels = () => view.root.findAllByType("button").map((b) => b.children.join(""));
  try {
    await act(async () => {
      view = create(createElement(OperationalAlerts, { snapshot, openSettings: async () => {} }));
    });
    const text = JSON.stringify(view.toJSON());
    expect(text).toContain("A booking arrived on closed nights");
    expect(text).toContain(
      "Airbnb sold nights that are closed in your calendar. The booking is saved.",
    );
    expect(text).toContain("Garden villa");
    expect(labels()).not.toContain("Retry recovery");
    expect(labels()).not.toContain("Retry import");
    vi.mocked(channexService.alertAction).mockImplementationOnce(async () => {
      alert = {
        ...alert,
        acknowledgedAt: "2026-10-27T11:00:00Z",
        resolvedAt: "2026-10-27T11:00:00Z",
      };
    });
    await act(async () => {
      view.root
        .findAllByType("button")
        .find((b) => b.children.join("") === "Mark checked")!
        .props.onClick();
    });
    expect(channexService.alertAction).toHaveBeenCalledWith("closed", "acknowledge", 0);
    expect(JSON.stringify(view.toJSON())).toContain("Marked checked.");
    expect(labels()).not.toContain("Mark checked");
  } finally {
    if (view) act(() => view.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps Retry import off when the alert names no revision, and says a closed alert was not checked", async () => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  const base = {
    firstOccurredAt: "2026-10-27T10:00:00Z",
    lastOccurredAt: "2026-10-27T10:00:00Z",
    acknowledgedAt: null,
    recoveryRound: 0,
    occurrences: 0,
    recovery: [],
  };
  vi.mocked(channexService.getAlerts).mockResolvedValue([
    {
      ...base,
      id: "no-revision",
      eventType: "booking_not_imported",
      impact: { bookingId: "chx-booking", errorType: "worker_lease_expired" },
      resolvedAt: null,
    } as ChannexAlert,
    {
      ...base,
      id: "moved",
      eventType: "booking_on_closed_night",
      impact: { bookingId: "chx-other", errorType: "inventory_closed" },
      resolvedAt: "2026-10-27T12:00:00Z",
    } as ChannexAlert,
  ]);
  const snapshot = {
    sync: { booking: { retryAfter: null }, ari: { retryAfter: null } },
    capabilityModes: { bookingSync: "mutating", ariSync: "mutating", iframe: "mutating" },
  } as ChannexSnapshot;
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(createElement(OperationalAlerts, { snapshot, openSettings: async () => {} }));
    });
    const text = JSON.stringify(view.toJSON());
    expect(
      view.root.findAllByType("button").find((b) => b.children.join("") === "Retry import")!.props
        .disabled,
    ).toBe(true);
    expect(text).toContain("can't be retried from here");
    expect(text).toContain("Closed: a later update moved or cancelled this booking.");
    expect(text).not.toContain("Marked checked.");
  } finally {
    if (view) act(() => view.unmount());
    vi.unstubAllGlobals();
  }
});
