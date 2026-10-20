import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingPublicationReview } from "@/services/api/bookingPublicationReviewClient";
import { ApiErrorResponse } from "@/services/api/client";

import {
  quickReadinessMessage,
  useQuickPublication,
  type QuickPublicationClient,
  type QuickPublicationState,
} from "./useQuickPublication";

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const ORGANIZATION = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f99887766";
const STORAGE_KEY = `vayada:booking-publication:${ORGANIZATION}:${PROPERTY}`;
const HASH = (digit: string) => `sha256:${digit.repeat(64)}`;
const REVISION = "11111111-2222-4333-8444-555555555555";
const OPERATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function blocker(kind: "user_fixable" | "external_pending", message: string) {
  return { kind, message, code: "x" };
}

function review(overrides: Partial<BookingPublicationReview> = {}, blockers: object[] = []) {
  return {
    contractVersion: "booking-publication-review.v1",
    propertyId: PROPERTY,
    activeContentRevisionId: null,
    publishedUrl: null,
    latestOperation: null,
    recoveredOperation: null,
    readiness: {
      outcome: "evaluated",
      status: blockers.length ? "blocked" : "ready",
      readinessHash: HASH("a"),
      sourceManifestHash: HASH("b"),
      groups: blockers.length ? [{ steps: [{ entities: [{ blockers }] }] }] : [],
    },
    ...overrides,
  } as unknown as BookingPublicationReview;
}

function operation(status: "pending" | "succeeded" | "failed", failureCode: string | null = null) {
  return {
    propertyId: PROPERTY,
    operationId: OPERATION,
    status,
    expectedActiveContentRevisionId: null,
    resultContentRevisionId: status === "succeeded" ? REVISION : null,
    failureCode,
    requestedAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-20T10:00:01Z",
    completedAt: status === "pending" ? null : "2026-10-20T10:00:02Z",
  } as never;
}

const LIVE = review({
  activeContentRevisionId: REVISION,
  publishedUrl: "https://hotel-alpenrose.booking.vayada.com/en",
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

type Hook = ReturnType<typeof useQuickPublication>;

async function mount(client: QuickPublicationClient, storage = memoryStorage()) {
  const seen: { current: Hook | null } = { current: null };
  function Harness() {
    seen.current = useQuickPublication({
      propertyId: PROPERTY,
      organizationId: ORGANIZATION,
      client,
      storage,
    });
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Harness />);
  });
  const state = () => seen.current!.state as QuickPublicationState;
  const run = async (action: (hook: Hook) => Promise<unknown>) =>
    act(async () => {
      await action(seen.current!);
    });
  return { state, run, storage, unmount: () => renderer!.unmount() };
}

beforeEach(() => {
  vi.stubGlobal("navigator", {
    locks: { request: (_key: string, action: () => unknown) => Promise.resolve(action()) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useQuickPublication (VAY-2247 step 5)", () => {
  it("publishes with the review's hashes, saves the request on this device, then shows the live page", async () => {
    const load = vi.fn().mockResolvedValueOnce(review()).mockResolvedValue(LIVE);
    const publish = vi.fn().mockResolvedValue(operation("pending"));
    const hook = await mount({ load, publish });
    expect(hook.state()).toEqual({ kind: "ready" });

    await hook.run((h) => h.publish());
    const attempt = publish.mock.calls[0]![0];
    expect(attempt).toMatchObject({
      propertyId: PROPERTY,
      idempotencyKey: expect.stringMatching(/^booking-review:/),
      body: {
        expectedActiveContentRevisionId: null,
        expectedSourceManifestHash: HASH("b"),
        expectedReadinessHash: HASH("a"),
      },
    });
    // The same saved request the setup "Booking Engine" card recovers.
    expect(JSON.parse(hook.storage.values.get(STORAGE_KEY)!)).toEqual(attempt);
    expect(load).toHaveBeenLastCalledWith(PROPERTY, attempt.idempotencyKey);
    expect(hook.state()).toEqual({
      kind: "live",
      url: "https://hotel-alpenrose.booking.vayada.com/en",
    });
    hook.unmount();
  });

  it("checks every two seconds while publishing", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const key = "booking-review:saved";
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        propertyId: PROPERTY,
        idempotencyKey: key,
        body: {
          expectedActiveContentRevisionId: null,
          expectedSourceManifestHash: HASH("b"),
          expectedReadinessHash: HASH("a"),
        },
      }),
    );
    const load = vi
      .fn()
      .mockResolvedValueOnce(review({ recoveredOperation: operation("pending") }))
      .mockResolvedValue(LIVE);
    const hook = await mount({ load, publish: vi.fn() }, storage);
    expect(hook.state()).toEqual({ kind: "publishing" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(PROPERTY, key);
    expect(hook.state()).toMatchObject({ kind: "live" });
    hook.unmount();
  });

  it("says what still stands in the way, and publishes on Try again once it's gone", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(
        review({}, [blocker("external_pending", "Room availability isn't prepared yet.")]),
      )
      .mockResolvedValueOnce(review())
      .mockResolvedValue(LIVE);
    const publish = vi.fn().mockResolvedValue(operation("pending"));
    const hook = await mount({ load, publish });
    expect(hook.state()).toEqual({
      kind: "failed",
      message:
        "Room availability isn't prepared yet. This usually sorts itself out within a minute.",
    });
    await hook.run((h) => h.publish());
    expect(publish).not.toHaveBeenCalled();
    await hook.run((h) => h.retry());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(hook.state()).toMatchObject({ kind: "live" });
    hook.unmount();
  });

  it("sends a request the server never confirmed again, with the same key", async () => {
    const storage = memoryStorage();
    const saved = {
      propertyId: PROPERTY,
      idempotencyKey: "booking-review:lost",
      body: {
        expectedActiveContentRevisionId: null,
        expectedSourceManifestHash: HASH("b"),
        expectedReadinessHash: HASH("a"),
      },
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(saved));
    const load = vi
      .fn()
      .mockResolvedValueOnce(review())
      .mockResolvedValueOnce(review())
      .mockResolvedValue(LIVE);
    const publish = vi.fn().mockResolvedValue(operation("pending"));
    const hook = await mount({ load, publish }, storage);
    expect(hook.state()).toEqual({
      kind: "failed",
      message: "We couldn't confirm that your booking page was published. Try again.",
    });
    await hook.run((h) => h.retry());
    expect(publish).toHaveBeenCalledWith(saved);
    expect(hook.state()).toMatchObject({ kind: "live" });
    hook.unmount();
  });

  it("forgets a request the server refused because the hotel changed", async () => {
    const load = vi.fn().mockResolvedValue(review());
    const publish = vi
      .fn()
      .mockRejectedValue(
        new ApiErrorResponse(409, { code: "invalid_readiness_evidence" } as never),
      );
    const hook = await mount({ load, publish });
    await hook.run((h) => h.publish());
    expect(hook.state()).toEqual({
      kind: "failed",
      message: "Your hotel changed while we were publishing. Try again.",
    });
    expect(hook.storage.values.has(STORAGE_KEY)).toBe(false);
    hook.unmount();
  });

  it("lets an older failed request go when the page can be published now", async () => {
    const storage = memoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        propertyId: PROPERTY,
        idempotencyKey: "booking-review:old",
        body: {
          expectedActiveContentRevisionId: null,
          expectedSourceManifestHash: HASH("b"),
          expectedReadinessHash: HASH("a"),
        },
      }),
    );
    const load = vi
      .fn()
      .mockResolvedValue(review({ recoveredOperation: operation("failed", "projection_failed") }));
    const hook = await mount({ load, publish: vi.fn() }, storage);
    expect(hook.state()).toEqual({ kind: "ready" });
    hook.unmount();
  });

  it("opens straight on the live page when it is already published", async () => {
    const hook = await mount({ load: vi.fn().mockResolvedValue(LIVE), publish: vi.fn() });
    expect(hook.state()).toEqual({
      kind: "live",
      url: "https://hotel-alpenrose.booking.vayada.com/en",
    });
    hook.unmount();
  });
});

describe("quickReadinessMessage", () => {
  it("uses the first open item, and says when the check itself is down", () => {
    expect(quickReadinessMessage(review().readiness)).toBeNull();
    expect(
      quickReadinessMessage(
        review({}, [
          blocker("user_fixable", "Confirm that your prices include taxes and fees."),
          blocker("external_pending", "Later"),
        ]).readiness,
      ),
    ).toBe("Confirm that your prices include taxes and fees.");
    expect(quickReadinessMessage({ outcome: "provider_failure" } as never)).toBe(
      "We can't check your booking page right now. Try again in a minute.",
    );
  });
});
