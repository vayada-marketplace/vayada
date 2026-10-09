import { describe, expect, it, vi } from "vitest";

import {
  createPricingPublicationFreshnessAlert,
  summarizePricingPublicationFreshness,
} from "./pricingPublicationFreshness.js";

describe("summarizePricingPublicationFreshness", () => {
  it("counts stale and unreadable publications as problems, lock timeouts only as counts", () => {
    expect(
      summarizePricingPublicationFreshness([
        { propertyId: "a", revision: 3, stale: [] },
        { propertyId: "b", revision: 1, stale: ["finance"] },
        { propertyId: "c", error: "lock_timeout" },
        { propertyId: "d", error: "unreadable" },
      ]),
    ).toEqual({
      checked: 4,
      stale: 1,
      unreadable: 1,
      lockTimeouts: 1,
      problems: 2,
      staleProperties: [{ propertyId: "b", revision: 1, stale: ["finance"] }],
      unreadableProperties: [{ propertyId: "d", error: "unreadable" }],
    });
  });

  it("reports no problems for current or absent publications", () => {
    expect(summarizePricingPublicationFreshness([])).toMatchObject({ checked: 0, problems: 0 });
    expect(
      summarizePricingPublicationFreshness([
        { propertyId: "a", revision: 2, stale: [] },
        { propertyId: "b", error: "lock_timeout" },
      ]),
    ).toMatchObject({ checked: 2, lockTimeouts: 1, problems: 0 });
  });

  it("caps the listed properties so the log line stays small", () => {
    const report = Array.from({ length: 25 }, (_, index) => ({
      propertyId: String(index),
      revision: 1,
      stale: ["room" as const],
    }));
    const summary = summarizePricingPublicationFreshness(report);
    expect(summary).toMatchObject({ stale: 25, problems: 25 });
    expect(summary.staleProperties).toHaveLength(20);
  });
});

describe("createPricingPublicationFreshnessAlert", () => {
  const stale = summarizePricingPublicationFreshness([
    { propertyId: "p-1", revision: 4, stale: ["finance", "terms"] },
    { propertyId: "p-2", error: "unreadable" },
  ]);

  function setup(start = "2026-10-10T08:00:00.000Z") {
    let now = new Date(start);
    const send = vi.fn<
      (input: {
        to: string;
        subject: string;
        text: string;
        idempotencyKey: string;
      }) => Promise<void>
    >(async () => {});
    const alert = createPricingPublicationFreshnessAlert({
      to: "ops@example.test",
      delivery: { send },
      now: () => now,
    });
    return { alert, send, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }

  it("emails the findings and what to do", async () => {
    const { alert, send } = setup();
    await expect(alert(stale)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@example.test",
        subject: 'Vayada: 2 published price list(s) need "Save prices"',
        idempotencyKey: expect.stringMatching(
          /^pricing-publication-freshness:2026-10-10:[0-9a-f]{32}$/,
        ),
      }),
    );
    const { text } = send.mock.calls[0]![0];
    expect(text).toContain("- p-1: finance, terms");
    expect(text).toContain("Unreadable (property id):\n- p-2");
    expect(text).toContain('presses "Save prices"');
  });

  it("sends nothing without problems", async () => {
    const { alert, send } = setup();
    await expect(
      alert(summarizePricingPublicationFreshness([{ propertyId: "a", error: "lock_timeout" }])),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends at most once a day while the problem lasts", async () => {
    const { alert, send, advance } = setup();
    await alert(stale);
    advance(23 * 60 * 60 * 1000);
    await expect(alert(stale)).resolves.toBe(false);
    advance(60 * 60 * 1000);
    await expect(alert(stale)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses the same idempotency key for the same findings on the same day", async () => {
    const first = setup("2026-10-10T01:00:00.000Z");
    const second = setup("2026-10-10T22:00:00.000Z");
    await first.alert(stale);
    await second.alert(stale);
    expect(second.send.mock.calls[0]![0].idempotencyKey).toBe(
      first.send.mock.calls[0]![0].idempotencyKey,
    );
  });

  it("retries on the next run after a failed send", async () => {
    const { alert, send, advance } = setup();
    send.mockRejectedValueOnce(new Error("Booking email provider returned HTTP 500."));
    await expect(alert(stale)).rejects.toThrow("HTTP 500");
    advance(60 * 60 * 1000);
    await expect(alert(stale)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
