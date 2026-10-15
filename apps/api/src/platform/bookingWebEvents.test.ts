import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyBookingWebTraffic, createPgBookingWebEventSink } from "./bookingWebEvents.js";

const query = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [] }));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = query;
    },
  },
}));

describe("affiliate click occurrence persistence", () => {
  beforeEach(() => query.mockClear());
  const event = {
    slug: "hotel",
    referralCode: "A",
    sessionId: "session",
    requestId: "request",
    occurredAt: new Date("2026-09-09T12:00:00Z"),
    metadata: {},
  };

  it("retains A → B → A while retrying the final click uses the same event and audit identity", async () => {
    const sink = createPgBookingWebEventSink({ connectionString: "unused" });
    for (const [referralCode, clickId, requestId] of [
      ["A", "click-1", "request-1"],
      ["B", "click-2", "request-2"],
      ["A", "click-3", "request-3"],
      ["A", "click-3", "retry-request"],
    ]) {
      await sink.recordAffiliateClick({ ...event, referralCode, clickId, requestId });
    }
    const values = query.mock.calls.map(([, values]) => values as unknown[]);
    expect(new Set(values.map((v) => v[1])).size).toBe(3);
    expect(values[2][1]).toBe(values[3][1]);
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (source_system, event_key) DO NOTHING");
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (product, audit_key) DO NOTHING");
    const payloads = values.map((v) =>
      v
        .filter((x) => typeof x === "string" && x.startsWith("{"))
        .map((x) => JSON.parse(x as string))
        .find((x) => x.clickId),
    );
    expect(payloads.map((p) => [p.referralCode, p.clickId, p.sessionId])).toEqual([
      ["A", "click-1", "session"],
      ["B", "click-2", "session"],
      ["A", "click-3", "session"],
      ["A", "click-3", "session"],
    ]);
  });

  it("does not collapse callers without a click ID or collide across hotels/referrals", async () => {
    const sink = createPgBookingWebEventSink({ connectionString: "unused" });
    await sink.recordAffiliateClick(event);
    await sink.recordAffiliateClick(event);
    await sink.recordAffiliateClick({ ...event, clickId: "same" });
    await sink.recordAffiliateClick({ ...event, clickId: "same", slug: "another-hotel" });
    await sink.recordAffiliateClick({ ...event, clickId: "same", referralCode: "B" });
    expect(new Set(query.mock.calls.map(([, values]) => values[1])).size).toBe(5);
  });
});

describe("Booking Web funnel event persistence", () => {
  beforeEach(() => query.mockClear());

  it("stores no request id and no IP or user-agent hashes (VAY-2197)", async () => {
    const sink = createPgBookingWebEventSink({ connectionString: "unused" });
    await sink.recordTelemetryEvent({
      propertyId: "11111111-1111-4111-8111-111111111111",
      hotelSlug: "hotel",
      eventType: "step_viewed",
      eventId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      occurredAt: new Date("2026-10-15T12:00:00Z"),
      userAgent: "Googlebot/2.1",
      metadata: { funnelVersion: 1, funnelSequence: 2, step: "extras" },
    });
    const values = query.mock.calls[0]![1] as unknown[];
    const stored = JSON.stringify(values);
    expect(JSON.parse(values[12] as string)).toEqual({
      source: "apps/api-booking-web-public",
      trafficClass: "bot",
    });
    expect(values[9]).toBe("33333333-3333-4333-8333-333333333333");
    expect(stored).not.toMatch(/requestId|ipAddress|userAgent|Googlebot/);
  });
});

describe("Booking Web telemetry traffic policy", () => {
  it.each([
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "Mozilla/5.0 HeadlessChrome/127.0.0.0",
    "UptimeRobot/2.0",
  ])("classifies automated user agents as bot traffic", (userAgent) => {
    expect(classifyBookingWebTraffic(userAgent)).toBe("bot");
  });

  it("keeps browsers and older missing user-agent evidence in the human class", () => {
    expect(classifyBookingWebTraffic("Mozilla/5.0 Safari/605.1.15")).toBe("human");
    expect(classifyBookingWebTraffic(undefined)).toBe("human");
  });
});
