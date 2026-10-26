import { describe, expect, it, vi } from "vitest";

import {
  CONTACT_INTAKE_RETENTION,
  createPgContactIntakeRetentionStore,
  startContactIntakeRetentionWorker,
  type ContactIntakeRetentionStore,
} from "./contactIntakeRetention.js";

describe("contact intake retention (VAY-2286)", () => {
  it("empties contact jobs older than 90 days without deleting rows", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const store = createPgContactIntakeRetentionStore({
      connectionString: "postgres://target",
      pool: {
        async query(text, values) {
          calls.push({ text, values });
          return { rows: [{ purged: 3 }] };
        },
        async end() {},
      },
    });

    await expect(store.purgeExpiredBatch(new Date("2026-10-18T00:00:00.000Z"), 10)).resolves.toBe(
      3,
    );
    await expect(store.purgeExpiredBatch(new Date(), 0)).rejects.toThrow("positive integer");

    expect(CONTACT_INTAKE_RETENTION).toBe("90 days");
    expect(calls[0]?.text).toContain("UPDATE platform.jobs");
    expect(calls[0]?.text).toContain("SET payload = '{}'::jsonb");
    expect(calls[0]?.text).not.toMatch(/DELETE\s+FROM/i);
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining([
        "2026-10-18T00:00:00.000Z",
        10,
        "90 days",
        "platform.email",
        "email.platform-contact-notification",
      ]),
    );
  });

  it("drains full batches and logs the total", async () => {
    const batches = [2, 2, 1];
    const store: ContactIntakeRetentionStore = {
      purgeExpiredBatch: vi.fn(async () => batches.shift() ?? 0),
      close: vi.fn(async () => {}),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startContactIntakeRetentionWorker({
      store,
      enabled: false,
      batchSize: 2,
      logger,
    });

    await worker.runNow();
    await worker.close();

    expect(store.purgeExpiredBatch).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith({ purged: 5 }, "Purged expired contact messages");
    expect(store.close).toHaveBeenCalled();
  });
});
