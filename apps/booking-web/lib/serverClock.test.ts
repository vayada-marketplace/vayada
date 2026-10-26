/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceTimeOf, observeServerTime, resetServerClock, serverNow } from "./serverClock";

const server = Date.parse("2026-10-13T10:45:49.224Z");

beforeEach(() => {
  sessionStorage.clear();
  resetServerClock();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it("uses the device clock until the server has been observed", () => {
  vi.setSystemTime(server);
  expect(serverNow()).toBe(server);
  expect(deviceTimeOf(new Date(server + 1000).toISOString())).toBe(server + 1000);
});

it.each([
  ["1 s behind", -1000],
  ["2 min behind", -120_000],
  ["1 s ahead", 1000],
  ["2 min ahead", 120_000],
])("follows the server when the device clock is %s (VAY-2134)", (_label, skew) => {
  vi.setSystemTime(server + skew);
  observeServerTime(new Date(server).toISOString());
  expect(serverNow()).toBe(server);
  vi.advanceTimersByTime(60_000);
  expect(serverNow()).toBe(server + 60_000);
  expect(deviceTimeOf(new Date(server + 300_000).toISOString())).toBe(server + skew + 300_000);
});

it("keeps the closest estimate: a late or old timestamp can't pull it back", () => {
  vi.setSystemTime(server);
  observeServerTime(new Date(server - 50).toISOString());
  observeServerTime(new Date(server - 360_000).toISOString());
  expect(serverNow()).toBe(server - 50);
  observeServerTime(new Date(server + 200).toISOString());
  expect(serverNow()).toBe(server + 200);
  observeServerTime("not a time");
  expect(serverNow()).toBe(server + 200);
});

it("restores a recent estimate after a reload, but not an old one", () => {
  vi.setSystemTime(server + 360_000);
  observeServerTime(new Date(server).toISOString());
  resetServerClock();
  vi.advanceTimersByTime(60_000);
  expect(serverNow()).toBe(server + 60_000);
  resetServerClock();
  vi.advanceTimersByTime(16 * 60_000);
  expect(serverNow()).toBe(server + 360_000 + 17 * 60_000);
});

it("works without tab storage", () => {
  vi.stubGlobal("sessionStorage", undefined);
  try {
    vi.setSystemTime(server - 1000);
    observeServerTime(new Date(server).toISOString());
    expect(serverNow()).toBe(server);
  } finally {
    vi.unstubAllGlobals();
  }
});
