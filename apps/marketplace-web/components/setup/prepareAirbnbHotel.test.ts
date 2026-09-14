import { afterEach, expect, it, vi } from "vitest";
import { prepareAirbnbHotel } from "./prepareAirbnbHotel";
const id = "10090000-0000-4000-8000-000000000001";
const operation = {
  operationId: id,
  propertyId: id,
  commandId: id,
  operationType: "enable",
  status: "queued",
};
const snapshot = {
  propertyId: id,
  connection: { status: "disconnected", externalPropertyId: null },
};
afterEach(() => vi.useRealTimers());
it("queues enable once and waits for the scoped job to succeed", async () => {
  vi.useFakeTimers();
  const get = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...operation, status: "succeeded" });
  const post = vi.fn().mockResolvedValue(operation);
  const result = prepareAirbnbHotel({ get, post }, id, id, new AbortController().signal);
  await vi.runAllTimersAsync();
  await result;
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]![1]).toEqual({
    commandId: id,
    idempotencyKey: `airbnb-prepare:${id}:${id}`,
    operationType: "enable",
  });
  expect(get.mock.calls[1]![0]).toContain(`/operations/${id}`);
});
it.each(["connected", "suspended", "setup_incomplete"])(
  "does not enable an existing %s connection",
  async (status) => {
    const post = vi.fn();
    const get = vi
      .fn()
      .mockResolvedValue({ ...snapshot, connection: { status, externalPropertyId: id } });
    await expect(
      prepareAirbnbHotel({ get, post }, id, id, new AbortController().signal),
    ).rejects.toThrow("existing connection");
    expect(post).not.toHaveBeenCalled();
  },
);
it.each(["failed", "dead_lettered", "unknown"])(
  "stops on terminal or unknown job state %s",
  async (status) => {
    await expect(
      prepareAirbnbHotel(
        {
          get: vi.fn().mockResolvedValue(snapshot),
          post: vi.fn().mockResolvedValue({ ...operation, status }),
        },
        id,
        id,
        new AbortController().signal,
      ),
    ).rejects.toThrow("did not finish");
  },
);
it("bounds waiting and preserves the durable command for retry", async () => {
  vi.useFakeTimers();
  const get = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(operation);
  const post = vi.fn().mockResolvedValue(operation);
  const result = expect(
    prepareAirbnbHotel({ get, post }, id, id, new AbortController().signal),
  ).rejects.toThrow("still running");
  await vi.runAllTimersAsync();
  await result;
  expect(post).toHaveBeenCalledTimes(1);
});
it("aborts waiting when the page is left", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const get = vi.fn().mockResolvedValue(snapshot);
  const result = expect(
    prepareAirbnbHotel(
      { get, post: vi.fn().mockResolvedValue(operation) },
      id,
      id,
      controller.signal,
    ),
  ).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await result;
  expect(get).toHaveBeenCalledTimes(1);
});

it("accepts success on the final allowed poll", async () => {
  vi.useFakeTimers();
  const get = vi.fn().mockResolvedValueOnce(snapshot);
  for (let i = 0; i < 29; i++) get.mockResolvedValueOnce(operation);
  get.mockResolvedValueOnce({ ...operation, status: "succeeded" });
  const result = prepareAirbnbHotel(
    { get, post: vi.fn().mockResolvedValue(operation) },
    id,
    id,
    new AbortController().signal,
  );
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBeUndefined();
});

it("times out a stalled API request", async () => {
  vi.useFakeTimers();
  const get = vi.fn(
    (_path, options) =>
      new Promise<never>((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason)),
      ),
  );
  const result = expect(
    prepareAirbnbHotel({ get, post: vi.fn() }, id, id, new AbortController().signal),
  ).rejects.toThrow("progress could not be confirmed");
  await vi.advanceTimersByTimeAsync(70_000);
  await result;
});
