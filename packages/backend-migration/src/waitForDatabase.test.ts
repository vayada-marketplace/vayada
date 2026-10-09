import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";

import { errorCode, isTransientDatabaseError, waitForDatabase } from "./waitForDatabase.js";

const failure = (code: string) => Object.assign(new Error(code), { code });

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe("waitForDatabase", () => {
  it("retries transient failures with backoff until the database answers", async () => {
    const clock = fakeClock();
    const outcomes = [failure("EHOSTUNREACH"), failure("ECONNREFUSED"), failure("57P03")];
    const logs: string[] = [];
    await waitForDatabase({
      connectionString: "postgresql://example/target",
      timeoutMs: 120_000,
      log: (message) => logs.push(message),
      probe: async () => {
        const outcome = outcomes.shift();
        if (outcome) throw outcome;
      },
      ...clock,
    });
    expect(clock.sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(logs).toEqual([
      "Database unavailable (EHOSTUNREACH); retrying in 1s.",
      "Database unavailable (ECONNREFUSED); retrying in 2s.",
      "Database unavailable (57P03); retrying in 4s.",
      "Database reachable after 4 attempts.",
    ]);
  });

  it("gives up once the wait budget is spent", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const error = await waitForDatabase({
      connectionString: "postgresql://example/target",
      timeoutMs: 120_000,
      log: () => undefined,
      probe: async (_connectionString, timeoutMs) => {
        attempts += 1;
        expect(timeoutMs).toBeLessThanOrEqual(5_000);
        throw failure("ETIMEDOUT");
      },
      ...clock,
    }).then(
      () => undefined,
      (failed: unknown) => failed,
    );
    expect(error).toMatchObject({ code: "ETIMEDOUT" });
    expect(clock.now()).toBeLessThan(120_000);
    expect(clock.sleeps.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
    expect(attempts).toBe(clock.sleeps.length + 1);
  });

  it("fails at once on authentication and configuration errors", async () => {
    const clock = fakeClock();
    await expect(
      waitForDatabase({
        connectionString: "postgresql://example/target",
        timeoutMs: 120_000,
        log: () => undefined,
        probe: async () => {
          throw failure("28P01");
        },
        ...clock,
      }),
    ).rejects.toMatchObject({ code: "28P01" });
    expect(clock.sleeps).toEqual([]);
  });

  it("bounds a real wait against an unreachable server", async () => {
    const startedAt = Date.now();
    await expect(
      waitForDatabase({
        connectionString: "postgresql://vayada@127.0.0.1:1/target",
        timeoutMs: 2_500,
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("retries a server that accepts connections but never answers", async () => {
    // pg's own connect timeout carries no code; a silently dropping host fails this way.
    const sockets = new Set<import("node:net").Socket>();
    const server: Server = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const error = await waitForDatabase({
        connectionString: `postgresql://vayada@127.0.0.1:${port}/target`,
        timeoutMs: 1_500,
        log: () => undefined,
      }).then(
        () => undefined,
        (failed: unknown) => failed,
      );
      expect(error).toMatchObject({ message: "timeout expired" });
      expect(isTransientDatabaseError(error)).toBe(true);
      expect(errorCode(error)).toBe("timeout expired");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    [new Error("timeout expired"), true],
    [failure("ECONNREFUSED"), true],
    [failure("57P01"), true],
    [new Error("Connection terminated unexpectedly"), true],
    [failure("28P01"), false],
    [failure("3D000"), false],
    [new Error("self-signed certificate"), false],
  ])("classifies %s as transient=%s", (error, transient) => {
    expect(isTransientDatabaseError(error)).toBe(transient);
  });
});
