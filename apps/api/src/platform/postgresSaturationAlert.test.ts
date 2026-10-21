import { describe, expect, it, vi } from "vitest";

import type { PostgresSaturationEpisode } from "./postgresRuntime.js";
import { createPostgresSaturationAlert } from "./postgresSaturationAlert.js";

const episode: PostgresSaturationEpisode = {
  physicalPoolCount: 6,
  maxConnections: 13,
  totalConnections: 13,
  idleConnections: 5,
  waitingRequests: 9,
  stalledPools: 1,
  durationMs: 30_400,
};

describe("PostgreSQL saturation alert (VAY-2247 incident)", () => {
  it("emails the ops recipient once an hour at most, with the pool numbers and no hotel data", async () => {
    let time = Date.parse("2026-10-21T10:18:36Z");
    const send = vi.fn(async (_input: { text: string }) => undefined);
    const alert = createPostgresSaturationAlert({
      to: "ops@example.test",
      delivery: { send },
      now: () => new Date(time),
    });
    expect(await alert(episode)).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@example.test",
        subject: "Vayada: the API is waiting for database connections",
        emailProduct: "platform",
        idempotencyKey: expect.stringMatching(/^postgres-pool-saturation:[0-9a-f]{32}$/),
      }),
    );
    const text = send.mock.calls[0]![0].text;
    expect(text).toContain("At 2026-10-21 10:18 UTC");
    expect(text).toContain("for 30 s without a break");
    expect(text).toContain("Connections in use: 8 of 13 (6 pools).");
    expect(text).toContain("Requests waiting: 9. Pools that stopped handing out connections: 1.");

    time += 59 * 60 * 1000;
    expect(await alert(episode)).toBe(false);
    time += 60 * 1000;
    expect(await alert(episode)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("tries again on the next episode when a send fails", async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Resend unavailable"))
      .mockResolvedValue(undefined);
    const alert = createPostgresSaturationAlert({ to: "ops@example.test", delivery: { send } });
    await expect(alert(episode)).rejects.toThrow("Resend unavailable");
    expect(await alert(episode)).toBe(true);
  });
});
