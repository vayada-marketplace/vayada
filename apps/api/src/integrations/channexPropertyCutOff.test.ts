import { describe, expect, it, vi } from "vitest";
import {
  channexCutOffClosedDates as closedDates,
  createChannexPropertyTimeZoneRead,
  readChannexPropertyCutOff as read,
} from "./channexPropertyCutOff.js";

const id = "50e2edff-0399-4171-8e3e-ac04ffd3df24";
// Tiga's Channex property as read on 2026-11-18 (VAY-2108).
const tiga = (settings: Record<string, unknown> = {}) => ({
  data: {
    type: "property",
    id,
    attributes: {
      id,
      title: "Villa Sava",
      timezone: "Asia/Makassar",
      settings: {
        min_stay_type: "both",
        cut_off_time: "16:30:00",
        cut_off_days: 0,
        max_day_advance: null,
        ...settings,
      },
    },
  },
});
const at = (iso: string) => new Date(iso);

describe("Channex property cut-off (VAY-2108)", () => {
  it("reads the property's cut-off in its own time zone", async () => {
    const get = vi.fn(async () => tiga());
    expect(await read(id, get)).toEqual({
      timeZone: "Asia/Makassar",
      cutOffSeconds: 16.5 * 3600,
      cutOffDays: 0,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith("GET", `/api/v1/properties/${id}`);
  });

  it.each([
    [{ cut_off_time: null, cut_off_days: null }, null, 0],
    [{ cut_off_time: undefined, cut_off_days: undefined }, null, 0],
    [{ cut_off_time: "18:00", cut_off_days: 1 }, 18 * 3600, 1],
    [{ cut_off_time: "00:00:00", cut_off_days: 30 }, 0, 30],
    // A set time without a day count still closes the current date.
    [{ cut_off_time: "16:30:00", cut_off_days: null }, 16.5 * 3600, 0],
  ])("reads settings %j", async (settings, cutOffSeconds, cutOffDays) => {
    expect(await read(id, async () => tiga(settings))).toEqual({
      timeZone: "Asia/Makassar",
      cutOffSeconds,
      cutOffDays,
    });
  });

  it.each([
    { cut_off_time: "24:00:00" },
    { cut_off_time: "16:30:00Z" },
    { cut_off_time: "4pm" },
    { cut_off_time: 1630 },
    { cut_off_days: -1 },
    { cut_off_days: 31 },
    { cut_off_days: 1.5 },
    { cut_off_days: "0" },
  ])("refuses an unreadable cut-off %j", async (settings) => {
    await expect(read(id, async () => tiga(settings))).rejects.toThrow(
      "channex_cut_off_unavailable",
    );
  });

  it.each([
    {},
    { data: null },
    { data: { ...tiga().data, id: "other" } },
    { data: { ...tiga().data, type: "room_type" } },
    { data: { ...tiga().data, attributes: { ...tiga().data.attributes, id: "other" } } },
    { data: { ...tiga().data, attributes: { ...tiga().data.attributes, timezone: "Mars/Base" } } },
    { data: { ...tiga().data, attributes: { ...tiga().data.attributes, timezone: undefined } } },
    { data: { ...tiga().data, attributes: { ...tiga().data.attributes, settings: null } } },
    { ...tiga(), errors: {} },
    { ...tiga(), warnings: [] },
    { ...tiga(), meta: null },
    { ...tiga(), meta: { warnings: ["partial"] } },
  ])("refuses an ambiguous property response %j", async (body) => {
    await expect(read(id, async () => body)).rejects.toThrow("channex_cut_off_unavailable");
  });

  it("refuses a malformed property id before any read, and passes read failures on", async () => {
    const get = vi.fn();
    await expect(read("../other", get)).rejects.toThrow("channex_cut_off_unavailable");
    expect(get).not.toHaveBeenCalled();
    await expect(
      read(id, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });

  describe("closed dates", () => {
    const cutOff = (time: number | null, days = 0, timeZone = "Asia/Makassar") => ({
      timeZone,
      cutOffSeconds: time,
      cutOffDays: days,
    });
    const tigaCutOff = cutOff(16.5 * 3600);
    const night = (date: string, through = date) => ({ from: date, through });

    it.each([
      // 18 Nov, Asia/Makassar (UTC+8): open until 16:30, then closed until 02:00 the next morning.
      ["2026-11-18T00:00:00Z", null],
      ["2026-11-18T08:29:59Z", null],
      ["2026-11-18T08:30:00Z", night("2026-11-18")],
      // The send that jammed every Tiga sync went out at 20:52 hotel time.
      ["2026-11-18T12:52:00Z", night("2026-11-18")],
      ["2026-11-18T15:59:59Z", night("2026-11-18")],
      // After midnight the closed date is yesterday, which the PMS no longer sends anyway.
      ["2026-11-18T16:00:00Z", night("2026-11-18")],
      ["2026-11-18T17:59:59Z", night("2026-11-18")],
      ["2026-11-18T18:00:00Z", null],
    ])("Tiga's 16:30 cut-off at %s", (now, expected) => {
      expect(closedDates(tigaCutOff, at(now))).toEqual(expected);
    });

    it("closes the next cut_off_days dates as well", () => {
      expect(closedDates(cutOff(16.5 * 3600, 2), at("2026-11-18T12:52:00Z"))).toEqual(
        night("2026-11-18", "2026-11-20"),
      );
      expect(closedDates(cutOff(16.5 * 3600, 2), at("2026-11-18T17:00:00Z"))).toEqual(
        night("2026-11-18", "2026-11-20"),
      );
    });

    it("uses the Channex property's own time zone (Aether: 18:00 Asia/Colombo)", () => {
      const aether = cutOff(18 * 3600, 0, "Asia/Colombo");
      expect(closedDates(aether, at("2026-11-18T12:29:59Z"))).toBeNull();
      expect(closedDates(aether, at("2026-11-18T12:30:00Z"))).toEqual(night("2026-11-18"));
    });

    it("treats a cut-off before 02:00 as the end of the previous Channex date", () => {
      const midnight = cutOff(0, 0, "Europe/Berlin");
      // 23:00 and 02:00 Berlin (UTC+1 in November): nothing closed.
      expect(closedDates(midnight, at("2026-11-18T22:00:00Z"))).toBeNull();
      expect(closedDates(midnight, at("2026-11-19T01:00:00Z"))).toBeNull();
      // 00:30 Berlin on 19 Nov: Channex's date is still 18 Nov, and it is closed.
      expect(closedDates(midnight, at("2026-11-18T23:30:00Z"))).toEqual(night("2026-11-18"));
    });

    it("closes nothing without a cut-off time", () => {
      expect(closedDates(cutOff(null, 3), at("2026-11-18T12:52:00Z"))).toBeNull();
    });
  });
});

describe("Channex property time zone for the profile save (VAY-2582)", () => {
  it("reads the property's time zone with the API key, and fails when Channex can't answer", async () => {
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json(tiga()));
    const readZone = createChannexPropertyTimeZoneRead({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "test-key",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await readZone(id)).toBe("Asia/Makassar");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://app.channex.io/api/v1/properties/${id}`);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { "user-api-key": "test-key" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // Only the time zone counts: settings that the cut-off reader would refuse don't matter here.
    fetch.mockResolvedValueOnce(Response.json(tiga({ cut_off_days: 99 })));
    expect(await readZone(id)).toBe("Asia/Makassar");
    fetch.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(readZone(id)).rejects.toThrow("channex_property_http_503");
    fetch.mockResolvedValueOnce(Response.json({ data: { type: "property", id, attributes: {} } }));
    await expect(readZone(id)).rejects.toThrow("channex_property_time_zone_unreadable");
    fetch.mockResolvedValueOnce(
      Response.json({ data: { id: "another", attributes: tiga().data.attributes } }),
    );
    await expect(readZone(id)).rejects.toThrow("channex_property_time_zone_unreadable");
    await expect(readZone("not-a-channex-id")).rejects.toThrow("channex_property_id_invalid");
    // An invalid id never reaches Channex.
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
