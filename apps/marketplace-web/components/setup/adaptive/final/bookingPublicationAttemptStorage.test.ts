import { afterEach, expect, it, vi } from "vitest";
import {
  saveBookingPublicationAttempt,
  readBookingPublicationAttempt,
  clearRejectedBookingPublicationAttempt,
} from "./bookingPublicationAttemptStorage";
const propertyId = "22222222-2222-4222-8222-222222222222";
const attempt = (idempotencyKey: string) => ({
  propertyId,
  idempotencyKey,
  body: {
    expectedActiveContentRevisionId: null,
    expectedReadinessHash: `sha256:${"1".repeat(64)}`,
    expectedSourceManifestHash: `sha256:${"2".repeat(64)}`,
  },
});
function setup() {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const request = vi.fn((_key: string, action: () => unknown) => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  return { store, request };
}
afterEach(() => vi.unstubAllGlobals());
it("serializes simultaneous publishers without replacing the winner's recovery key", async () => {
  const { store, request } = setup();
  const outcomes = await Promise.allSettled([
    saveBookingPublicationAttempt(store, "org", attempt("A"), null),
    saveBookingPublicationAttempt(store, "org", attempt("B"), null),
  ]);
  expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "rejected"]);
  expect(readBookingPublicationAttempt(store, "org", propertyId)?.idempotencyKey).toBe("A");
  expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0]);
});
it("uses the same lock for replacement and rejected-request deletion", async () => {
  const { store, request } = setup();
  await saveBookingPublicationAttempt(store, "org", attempt("A"), null);
  const outcomes = await Promise.allSettled([
    saveBookingPublicationAttempt(store, "org", attempt("B"), "A"),
    clearRejectedBookingPublicationAttempt(store, "org", attempt("A")),
  ]);
  expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "rejected"]);
  expect(readBookingPublicationAttempt(store, "org", propertyId)?.idempotencyKey).toBe("B");
  expect(new Set(request.mock.calls.map((call) => call[0])).size).toBe(1);
});
it("fails before writing when browser coordination is unavailable", async () => {
  const { store } = setup();
  vi.stubGlobal("navigator", {});
  await expect(saveBookingPublicationAttempt(store, "org", attempt("A"), null)).rejects.toThrow(
    "Web Locks",
  );
  expect(readBookingPublicationAttempt(store, "org", propertyId)).toBeNull();
});
