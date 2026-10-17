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

describe("Booking Web funnel event persistence", () => {
  beforeEach(() => query.mockClear());
  const event = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    hotelSlug: "hotel",
    eventType: "step_viewed",
    eventId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    occurredAt: new Date("2026-10-15T12:00:00Z"),
    userAgent: "Mozilla/5.0 Safari/605.1.15",
    metadata: { funnelVersion: 1, funnelSequence: 2, step: "extras" },
  };

  it("stores the event in its own table with no slug, request id or visitor traces (VAY-2212)", async () => {
    const sink = createPgBookingWebEventSink({ connectionString: "unused" });
    await sink.recordTelemetryEvent(event);
    expect(query).toHaveBeenCalledOnce();
    const [statement, values] = query.mock.calls[0]! as [string, unknown[]];
    expect(statement).toContain("INSERT INTO distribution.booking_web_events");
    expect(statement).toContain("ON CONFLICT (property_id, event_id) DO NOTHING");
    expect(statement).not.toMatch(/domain_events|product_audit_events/);
    expect(values).toEqual([
      event.propertyId,
      "step_viewed",
      event.eventId,
      event.sessionId,
      JSON.stringify(event.metadata),
      event.occurredAt,
    ]);
    expect(JSON.stringify(values)).not.toMatch(/hotel"|Safari|requestId|ipAddress|userAgent/);
  });

  it("stores nothing for bot traffic (VAY-2214)", async () => {
    const sink = createPgBookingWebEventSink({ connectionString: "unused" });
    await sink.recordTelemetryEvent({ ...event, userAgent: "Googlebot/2.1" });
    expect(query).not.toHaveBeenCalled();
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
