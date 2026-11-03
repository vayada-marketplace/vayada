import { describe, expect, it, vi } from "vitest";

import {
  followRoomChangesInCalendar,
  refreshPmsOperatingCalendarRooms,
  repairPmsOperatingCalendarRooms,
  startingSellableLimit,
  type PmsOperatingCalendarRoomRefreshPorts,
} from "./pmsOperatingCalendarRoomRefresh.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const organizationId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
const userId = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
// Sorted: the Studio, a garden room and the duplicated villa the calendar doesn't list yet.
const studio = "1a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const garden = "2a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const villa = "3a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const actor = { organizationId, propertyId, userId, requestId: "req-1", correlationId: null };
// 02:00 UTC is 10:00 on 3 November in Lombok.
const now = () => new Date("2026-11-03T02:00:00.000Z");
const confirmation = {
  contractVersion: "pms-operating-calendar-impact.v1",
  proposalFingerprint: "a".repeat(64),
  sourceFingerprint: "b".repeat(64),
  token: "confirm-1",
  issuedAt: "2026-11-03T02:00:00.000Z",
  expiresAt: "2026-11-03T02:15:00.000Z",
};
const binding = (roomTypeId: string, units: number, count: number, limit: number) => ({
  roomTypeId,
  sourceRoomFactsRevision: 1,
  sourceRoomUnitsRevision: units,
  physicalCapacityCount: count,
  startingSellableLimitCount: limit,
});
// Open April to October with a two-night minimum; the Studio sells its one room, the garden
// rooms two of four.
const configuration = {
  calendarRevision: 4,
  schedule: { mode: "recurring", periods: [{ startsOn: "04-01", endsOn: "10-31" }] },
  defaultMinimumStayNights: 2,
  sourceInputs: {
    propertyTimeZone: "Asia/Makassar",
    roomBindings: [binding(studio, 3, 1, 1), binding(garden, 2, 4, 2)],
  },
};
// The Studio went from one room to three, the garden rooms from four to one, and the villa
// (duplicated from the Studio) got two.
const roomChange = [
  { code: "room_type_set_conflict", currentRoomTypeIds: [studio, garden, villa] },
  { code: "room_units_revision_conflict", roomTypeId: studio, currentRevision: 5 },
  { code: "room_units_revision_conflict", roomTypeId: garden, currentRevision: 3 },
];
const capacities: Record<string, { roomUnitsRevision: number; activeUnitCount: number }> = {
  [studio]: { roomUnitsRevision: 5, activeUnitCount: 3 },
  [garden]: { roomUnitsRevision: 3, activeUnitCount: 1 },
  [villa]: { roomUnitsRevision: 4, activeUnitCount: 2 },
};

type Start = {
  current?: "current" | "stale" | null;
  conflicts?: readonly Record<string, unknown>[];
  coverage?: { calendarRevision: number; through: string } | null;
  capacity?: typeof capacities;
  preview?: unknown;
  save?: unknown;
  materialize?: unknown;
  candidates?: readonly Record<string, string>[];
  /** Room types whose nights hold more than the rooms they have now. */
  crowded?: readonly string[];
  /** The changed room type still has rooms waiting for their name. */
  unnamed?: boolean;
};

function fake(start: Start = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const status = start.current === undefined ? "stale" : start.current;
  const ports = {
    now,
    pool: {
      query: async (text: string, values: unknown[]) => {
        if (text.includes("JOIN LATERAL")) {
          calls.push(["candidates", { values }]);
          return { rows: start.candidates ?? [] };
        }
        if (text.includes("inventory_materialization_coverage")) {
          const coverage =
            start.coverage === undefined
              ? { calendarRevision: 4, through: "2027-03-31" }
              : start.coverage;
          return { rows: coverage ? [coverage] : [] };
        }
        if (text.includes("profile_revision")) return { rows: [{ profileRevision: "9" }] };
        if (text.includes("assigned_count")) {
          calls.push(["crowded", { values }]);
          return { rows: start.crowded?.includes(values[1] as string) ? [{ found: 1 }] : [] };
        }
        if (text.includes("operational_label_status")) return { rows: start.unnamed ? [{}] : [] };
        throw new Error(`unexpected query: ${text}`);
      },
    },
    calendarRead: {
      getCurrentOperatingCalendarConfiguration: async () =>
        status
          ? {
              configuration,
              sourceStatus: status,
              sourceConflicts: status === "stale" ? (start.conflicts ?? roomChange) : [],
            }
          : null,
    },
    rooms: {
      roomFacts: {
        listRoomTypeFacts: async () =>
          [studio, garden, villa].map((roomTypeId) => ({ roomTypeId, roomFactsRevision: 2 })),
      },
      roomCapacity: {
        getRoomTypeCapacity: async (_property: string, roomTypeId: string) => {
          const capacity = (start.capacity ?? capacities)[roomTypeId];
          return capacity ? { propertyId, roomTypeId, ...capacity } : null;
        },
      },
    },
    preview: {
      previewOperatingCalendarImpact: async (command: Record<string, unknown>) => {
        calls.push(["preview", command]);
        return start.preview ?? { ok: true, preview: { confirmation } };
      },
    },
    calendar: {
      upsertOperatingCalendar: async (command: Record<string, unknown>) => {
        calls.push(["save", command]);
        return start.save ?? { ok: true, response: { configuration: { calendarRevision: 5 } } };
      },
    },
    materialization: {
      materializeInventory: async (command: Record<string, unknown>) => {
        calls.push(["materialize", command]);
        return start.materialize ?? { ok: true };
      },
    },
  } as unknown as PmsOperatingCalendarRoomRefreshPorts;
  return { ports, calls };
}

describe("the calendar follows room changes (VAY-2469)", () => {
  it("saves the calendar with the hotel's own schedule and limits, then prepares its nights", async () => {
    const { ports, calls } = fake();
    expect(await refreshPmsOperatingCalendarRooms(ports, actor)).toEqual({
      outcome: "refreshed",
      calendarRevision: 5,
      savedCalendar: true,
    });
    // The garden rooms went from four to one: their nights are checked first.
    expect(calls.map(([name]) => name)).toEqual(["crowded", "preview", "save", "materialize"]);
    expect(calls[0]![1]["values"]).toEqual([propertyId, garden, 1, "2026-11-03"]);
    calls.shift();
    const proposal = {
      organizationId,
      propertyId,
      expectedCalendarRevision: 4,
      expectedPropertyProfileRevision: 9,
      schedule: configuration.schedule,
      defaultMinimumStayNights: 2,
      roomTypeLimits: [
        // All of the Studio's rooms were on sale, so all three are now.
        {
          roomTypeId: studio,
          expectedRoomFactsRevision: 2,
          expectedRoomUnitsRevision: 5,
          startingSellableLimitCount: 3,
        },
        // Two of four were on sale; only one room is left.
        {
          roomTypeId: garden,
          expectedRoomFactsRevision: 2,
          expectedRoomUnitsRevision: 3,
          startingSellableLimitCount: 1,
        },
        // The duplicate sells both its rooms.
        {
          roomTypeId: villa,
          expectedRoomFactsRevision: 2,
          expectedRoomUnitsRevision: 4,
          startingSellableLimitCount: 2,
        },
      ],
    };
    const audit = {
      actor: { kind: "user", userId },
      requestId: "req-1",
      correlationId: null,
      requestedAt: "2026-11-03T02:00:00.000Z",
    };
    expect(calls[0]![1]).toEqual({ ...proposal, audit });
    expect(calls[1]![1]).toMatchObject({ ...proposal, impactConfirmation: confirmation, audit });
    expect(calls[1]![1]["idempotencyKey"]).toMatch(/^pms\.calendar-room-refresh\./);
    // Nights from today in Lombok through the hotel's own calendar end: no new dates open.
    expect(calls[2]![1]).toEqual({
      organizationId,
      propertyId,
      configurationSource: {
        ownerDomain: "pms",
        entityType: "pms_operating_calendar.v1",
        entityId: propertyId,
        revision: "calendar:5",
      },
      expectedMaterializedRevision: 5,
      horizon: { from: "2026-11-03", through: "2027-03-31" },
      idempotencyKey: expect.stringMatching(/^pms\.calendar-room-refresh\.inventory\./),
      audit,
    });
  });

  it("prepares at most a year of nights and leaves a calendar that has ended", async () => {
    const long = fake({ coverage: { calendarRevision: 4, through: "2028-06-30" } });
    await refreshPmsOperatingCalendarRooms(long.ports, actor);
    expect(long.calls.at(-1)![1]["horizon"]).toEqual({ from: "2026-11-03", through: "2027-11-03" });
    const ended = fake({ coverage: { calendarRevision: 4, through: "2026-11-02" } });
    expect(await refreshPmsOperatingCalendarRooms(ended.ports, actor)).toEqual({
      outcome: "not_room_change",
      reason: "calendar_ended",
    });
    expect(ended.calls).toEqual([]);
  });

  it("saves nothing when fewer rooms are left than a night holds", async () => {
    const { ports, calls } = fake({ crowded: [garden] });
    expect(await refreshPmsOperatingCalendarRooms(ports, actor)).toEqual({
      outcome: "not_room_change",
      reason: "room_capacity_protected",
    });
    expect(calls.map(([name]) => name)).toEqual(["crowded"]);
  });

  it("leaves a current calendar alone and only prepares nights a save left behind", async () => {
    const current = fake({ current: "current" });
    expect(await refreshPmsOperatingCalendarRooms(current.ports, actor)).toEqual({
      outcome: "current",
    });
    expect(current.calls).toEqual([]);
    const unprepared = fake({
      current: "current",
      coverage: { calendarRevision: 3, through: "2027-03-31" },
    });
    expect(await refreshPmsOperatingCalendarRooms(unprepared.ports, actor)).toEqual({
      outcome: "refreshed",
      calendarRevision: 4,
      savedCalendar: false,
    });
    expect(unprepared.calls.map(([name, command]) => [name, command["horizon"]])).toEqual([
      ["materialize", { from: "2026-11-03", through: "2027-03-31" }],
    ]);
  });

  it("leaves calendars that still need setup's calendar step", async () => {
    const cases: Array<[Start, unknown]> = [
      [{ current: null }, { outcome: "no_calendar" }],
      [{ coverage: null }, { outcome: "no_inventory" }],
      [
        {
          conflicts: [
            ...roomChange,
            { code: "property_profile_revision_conflict", currentRevision: 9 },
          ],
        },
        { outcome: "not_room_change", reason: "property_profile_revision_conflict" },
      ],
      // A duplicate before it has rooms: the calendar can't sell it, so nothing is saved.
      [
        { capacity: { ...capacities, [villa]: { roomUnitsRevision: 1, activeUnitCount: 0 } } },
        { outcome: "not_room_change", reason: "room_capacity_unavailable" },
      ],
    ];
    for (const [start, expected] of cases) {
      const { ports, calls } = fake(start);
      expect(await refreshPmsOperatingCalendarRooms(ports, actor)).toEqual(expected);
      expect(calls.filter(([name]) => name !== "crowded")).toEqual([]);
    }
  });

  it("reports a refused preview, save or night preparation without going further", async () => {
    const refused = { ok: false, error: { code: "setup_scope_unavailable" } };
    const preview = fake({ preview: refused });
    expect(await refreshPmsOperatingCalendarRooms(preview.ports, actor)).toEqual({
      outcome: "failed",
      step: "preview",
      error: refused.error,
    });
    expect(preview.calls.map(([name]) => name)).toEqual(["crowded", "preview"]);
    const save = fake({ save: refused });
    expect(await refreshPmsOperatingCalendarRooms(save.ports, actor)).toMatchObject({
      outcome: "failed",
      step: "save",
    });
    expect(save.calls.map(([name]) => name)).toEqual(["crowded", "preview", "save"]);
    const nights = fake({
      materialize: { ok: false, error: { code: "configuration_not_current" } },
    });
    expect(await refreshPmsOperatingCalendarRooms(nights.ports, actor)).toMatchObject({
      outcome: "failed",
      step: "inventory",
    });
  });

  it("keeps a lower sellable limit unless the rooms no longer cover it", () => {
    expect(startingSellableLimit(undefined, 2)).toBe(2);
    expect(startingSellableLimit(binding(studio, 1, 1, 1), 3)).toBe(3);
    expect(startingSellableLimit(binding(studio, 1, 4, 2), 3)).toBe(2);
    expect(startingSellableLimit(binding(studio, 1, 4, 2), 1)).toBe(1);
  });
});

describe("room commands bring the calendar along (VAY-2469)", () => {
  const command = {
    organizationId,
    propertyId,
    roomTypeId: studio,
    audit: {
      actor: { kind: "user" as const, userId },
      requestId: "req-2",
      correlationId: "corr-2",
      requestedAt: "2026-11-03T02:00:00.000Z",
    },
  };

  it("refreshes the calendar after a change and answers with the room command's own result", async () => {
    const { ports, calls } = fake();
    const log = vi.fn();
    const run = vi.fn(async () => ({ ok: true as const, response: { roomUnitsRevision: 6 } }));
    expect(await followRoomChangesInCalendar(run, ports, log)(command)).toEqual({
      ok: true,
      response: { roomUnitsRevision: 6 },
    });
    expect(calls.map(([name]) => name)).toEqual(["crowded", "preview", "save", "materialize"]);
    expect(calls[1]![1]["audit"]).toMatchObject({
      actor: { kind: "user", userId },
      requestId: "req-2",
      correlationId: "corr-2",
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("waits until the room type's new rooms are named, and skips a system's change", async () => {
    const unnamed = fake({ unnamed: true });
    await followRoomChangesInCalendar(async () => ({ ok: true }), unnamed.ports, vi.fn())(command);
    expect(unnamed.calls).toEqual([]);
    const system = fake();
    await followRoomChangesInCalendar(
      async () => ({ ok: true }),
      system.ports,
      vi.fn(),
    )({
      ...command,
      audit: { ...command.audit, actor: { kind: "system" as const, service: "x" } },
    });
    expect(system.calls).toEqual([]);
  });

  it("also catches up after a refused room command, which keeps its own answer", async () => {
    const { ports, calls } = fake();
    // A single room change is refused while the calendar is behind; afterwards a retry works.
    const refused = {
      ok: false as const,
      error: { code: "physical_room_protected", blockers: ["stale_calendar"] },
    };
    expect(await followRoomChangesInCalendar(async () => refused, ports, vi.fn())(command)).toBe(
      refused,
    );
    expect(calls.map(([name]) => name)).toEqual(["crowded", "preview", "save", "materialize"]);
  });

  it("logs a calendar that can't follow, and still answers with the room change", async () => {
    const log = vi.fn();
    const refused = fake({ preview: { ok: false, error: { code: "setup_scope_unavailable" } } });
    expect(
      await followRoomChangesInCalendar(async () => ({ ok: true }), refused.ports, log)(command),
    ).toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId, outcome: "failed", step: "preview" }),
      "PMS calendar did not follow a room change",
    );
    const broken = fake();
    (
      broken.ports.calendarRead as { getCurrentOperatingCalendarConfiguration: unknown }
    ).getCurrentOperatingCalendarConfiguration = async () => {
      throw new Error("lock timeout");
    };
    const thrown = vi.fn();
    expect(
      await followRoomChangesInCalendar(async () => ({ ok: true }), broken.ports, thrown)(command),
    ).toEqual({ ok: true });
    expect(thrown).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId, err: expect.any(Error) }),
      "PMS calendar did not follow a room change",
    );
  });
});

describe("the hourly repair (VAY-2469)", () => {
  it("refreshes each hotel behind its rooms as the last person who saved its calendar", async () => {
    const { ports, calls } = fake({
      candidates: [{ propertyId, organizationId, userId }],
    });
    expect(
      await repairPmsOperatingCalendarRooms(ports, {
        limit: 25,
        runId: "run-1",
        propertyIds: [propertyId],
      }),
    ).toEqual({ candidates: 1, refreshed: 1, unchanged: 0, failed: [] });
    expect(calls[0]).toEqual([
      "candidates",
      { values: [25, [propertyId], "pms.operations.manage"] },
    ]);
    expect(calls[2]![1]["audit"]).toMatchObject({
      actor: { kind: "user", userId },
      requestId: `pms.calendar-room-refresh.scheduler:run-1:${propertyId}`,
      correlationId: "run-1",
    });
  });

  it("counts hotels it couldn't repair and carries on", async () => {
    const { ports } = fake({
      candidates: [{ propertyId, organizationId, userId }],
      capacity: { ...capacities, [villa]: { roomUnitsRevision: 1, activeUnitCount: 0 } },
    });
    expect(await repairPmsOperatingCalendarRooms(ports, { limit: 25, runId: "run-2" })).toEqual({
      candidates: 1,
      refreshed: 0,
      unchanged: 0,
      failed: [{ propertyId, outcome: "not_room_change", detail: "room_capacity_unavailable" }],
    });
  });
});
