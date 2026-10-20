import { describe, expect, it } from "vitest";

import {
  firstRunInventoryHorizon,
  runFirstRunCalendar,
  type HotelFirstRunCalendarPorts,
} from "./hotelFirstRunCalendar.js";
import {
  firstRunGuestLanguage,
  runFirstRunGuestRules,
  type HotelFirstRunGuestRulesPorts,
} from "./hotelFirstRunGuestRules.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const actor: HotelFirstRunActor = {
  organizationId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
  propertyId,
  userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  requestId: "req-1",
  correlationId: null,
  requestedAt: "2026-10-20T23:30:00.000Z",
};
const roomTypes = [
  {
    roomTypeId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203",
    expectedRoomFactsRevision: 1,
    expectedRoomUnitsRevision: 4,
    activeUnitCount: 3,
  },
];
// A confirmation as the preview issues it; the save parser checks every field and the 15-minute window.
const confirmation = {
  contractVersion: "pms-operating-calendar-impact.v1",
  proposalFingerprint: "a".repeat(64),
  sourceFingerprint: "b".repeat(64),
  token: "confirm-1",
  issuedAt: "2026-10-20T23:30:00.000Z",
  expiresAt: "2026-10-20T23:45:00.000Z",
};
const calendarInput = {
  propertyProfileRevision: 2,
  timezone: "Europe/Berlin",
  roomTypes,
  inventoryPrepared: false,
};

function fakeCalendar(start: { current?: "current" | "stale"; revision?: number } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const ports = {
    calendarRead: {
      getCurrentOperatingCalendarConfiguration: async () =>
        start.current
          ? {
              sourceStatus: start.current,
              configuration: { calendarRevision: start.revision ?? 1 },
            }
          : null,
    },
    preview: {
      previewOperatingCalendarImpact: async (command: Record<string, unknown>) => {
        calls.push(["preview", command]);
        return { ok: true, preview: { confirmation } };
      },
    },
    calendar: {
      upsertOperatingCalendar: async (command: Record<string, unknown>) => {
        calls.push(["save", command]);
        return {
          ok: true,
          response: { configuration: { calendarRevision: (start.revision ?? 0) + 1 } },
        };
      },
    },
    materialization: {
      materializeInventory: async (command: Record<string, unknown>) => {
        calls.push(["materialize", command]);
        return { ok: true };
      },
    },
  } as unknown as HotelFirstRunCalendarPorts;
  return { ports, calls };
}

describe("first run step 5: the calendar (VAY-2247)", () => {
  it("opens the calendar all year with its impact confirmation, then prepares 365 days", async () => {
    const fake = fakeCalendar();
    expect(await runFirstRunCalendar(fake.ports, actor, calendarInput)).toEqual({
      ok: true,
      wrote: true,
    });
    expect(fake.calls.map(([name]) => name)).toEqual(["preview", "save", "materialize"]);
    expect(fake.calls[0]![1]).toMatchObject({
      expectedCalendarRevision: 0,
      expectedPropertyProfileRevision: 2,
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
    });
    expect(fake.calls[1]![1]).toMatchObject({ impactConfirmation: confirmation });
    // 23:30 UTC on 20 October is already 21 October in Berlin.
    expect(fake.calls[2]![1]).toMatchObject({
      expectedMaterializedRevision: 1,
      horizon: { from: "2026-10-21", through: "2027-10-21" },
    });
  });

  it("leaves a current, prepared calendar alone and only prepares days when they are missing", async () => {
    const prepared = fakeCalendar({ current: "current" });
    expect(
      await runFirstRunCalendar(prepared.ports, actor, {
        ...calendarInput,
        inventoryPrepared: true,
      }),
    ).toEqual({
      ok: true,
      wrote: false,
    });
    expect(prepared.calls).toEqual([]);
    const notPrepared = fakeCalendar({ current: "current", revision: 3 });
    await runFirstRunCalendar(notPrepared.ports, actor, calendarInput);
    expect(
      notPrepared.calls.map(([name, command]) => [name, command["expectedMaterializedRevision"]]),
    ).toEqual([["materialize", 3]]);
  });

  it("saves a stale calendar again from its current revision", async () => {
    const fake = fakeCalendar({ current: "stale", revision: 2 });
    await runFirstRunCalendar(fake.ports, actor, calendarInput);
    expect(fake.calls[0]![1]).toMatchObject({ expectedCalendarRevision: 2 });
    expect(fake.calls[2]![1]).toMatchObject({ expectedMaterializedRevision: 3 });
  });

  it("needs the hotel's time zone", async () => {
    const fake = fakeCalendar();
    expect(
      await runFirstRunCalendar(fake.ports, actor, { ...calendarInput, timezone: null }),
    ).toMatchObject({
      ok: false,
      code: "property_timezone_missing",
    });
    expect(fake.calls).toEqual([]);
  });

  it("computes the horizon in the hotel's time zone", () => {
    expect(firstRunInventoryHorizon("2026-10-20T23:30:00.000Z", "America/New_York")).toEqual({
      from: "2026-10-20",
      through: "2027-10-20",
    });
  });
});

function fakeGuestRules(start: { rules?: boolean; terms?: string; design?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const ports = {
    locality: {
      showCityAndCountry: async () => {
        calls.push(["locality", null]);
        return { ok: true };
      },
    },
    guestRules: {
      read: async () => (start.rules ? { revision: "r", choices: {} } : null),
      save: async (_scope: unknown, input: unknown) => calls.push(["rules", input]),
    },
    terms: {
      read: async () => ({ termsText: start.terms ?? null }),
      save: async (_scope: unknown, text: unknown, expected: unknown) => {
        calls.push(["terms", { text, expected }]);
        return { termsText: text };
      },
    },
    designRead: { getCurrentDesign: async () => (start.design ? { revision: 1 } : null) },
    design: {
      upsertDesign: async (command: unknown) => {
        calls.push(["design", command]);
        return { ok: true, outcome: "created", design: {} };
      },
    },
  } as unknown as HotelFirstRunGuestRulesPorts;
  return { ports, calls };
}

describe("first run step 6: guest rules, terms, page style and the city shown (VAY-2247)", () => {
  it("saves everything a fresh hotel is missing, in the hotel's language", async () => {
    const fake = fakeGuestRules();
    expect(
      await runFirstRunGuestRules(fake.ports, actor, {
        language: "de",
        hasCity: true,
        localityPublic: false,
      }),
    ).toEqual({ ok: true, wrote: true });
    expect(fake.calls.map(([name]) => name)).toEqual(["locality", "rules", "terms", "design"]);
    expect(fake.calls[1]![1]).toMatchObject({
      expectedRevision: null,
      confirmed: true,
      choices: { defaultGuestLanguage: "de", childrenEnabled: true, adultAgeThreshold: 12 },
    });
    expect(fake.calls[2]![1]).toMatchObject({ expected: null });
    expect(fake.calls[3]![1]).toMatchObject({
      expectedRevision: 0,
      choices: { fontPairing: "grand-classic" },
      audit: { source: "hotel_first_run" },
    });
  });

  it("keeps whatever the owner already set", async () => {
    const fake = fakeGuestRules({ rules: true, terms: "Our own terms.", design: true });
    expect(
      await runFirstRunGuestRules(fake.ports, actor, {
        language: "en",
        hasCity: true,
        localityPublic: true,
      }),
    ).toEqual({ ok: true, wrote: false });
    expect(fake.calls).toEqual([]);
  });

  it("doesn't turn on the city when the hotel has none", async () => {
    const fake = fakeGuestRules({ rules: true, terms: "x", design: true });
    await runFirstRunGuestRules(fake.ports, actor, {
      language: "en",
      hasCity: false,
      localityPublic: false,
    });
    expect(fake.calls).toEqual([]);
  });

  it("speaks to guests in English when the booking page can't speak the hotel's language", () => {
    expect(firstRunGuestLanguage("de-AT")).toBe("de");
    expect(firstRunGuestLanguage("it")).toBe("en");
    expect(firstRunGuestLanguage(null)).toBe("en");
  });
});
