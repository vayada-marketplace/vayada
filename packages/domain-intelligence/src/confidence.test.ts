import { describe, expect, it } from "vitest";

import { computeAskConfidence } from "./confidence.js";
import type { AskEvidenceEntry } from "./evidence.js";

function entry(overrides: Partial<AskEvidenceEntry> = {}): AskEvidenceEntry {
  return {
    evidenceId: "ev_1",
    sourceOwner: "booking",
    sourceView: "direct_booking_summary_read_model",
    product: "booking",
    resourceId: "hotel_1",
    resourceType: "booking_hotel",
    metricKey: "booking.direct_booking_share",
    filters: {},
    freshness: { status: "fresh", generatedAt: "2026-06-10T08:00:00Z" },
    quality: "complete",
    sampleSize: 48,
    valueSummary: { directSharePct: 62.5 },
    ...overrides,
  };
}

describe("computeAskConfidence", () => {
  it("is unknown without cited evidence", () => {
    expect(
      computeAskConfidence({ evidence: [], failedToolCount: 0, unavailableDataCount: 0 }),
    ).toEqual({ level: "unknown", reasons: ["no_cited_evidence"] });
  });

  it("is high for fresh, complete evidence with sufficient sample", () => {
    expect(
      computeAskConfidence({
        evidence: [entry()],
        failedToolCount: 0,
        unavailableDataCount: 0,
      }),
    ).toEqual({ level: "high", reasons: ["fresh_internal_metrics", "complete_source"] });
  });

  it("downgrades to medium for stale, partial, or small-sample evidence", () => {
    for (const overrides of [
      { freshness: { status: "stale" as const } },
      { quality: "partial" as const },
      { sampleSize: 3 },
      { quality: "hotelier_entered" as const },
    ]) {
      const result = computeAskConfidence({
        evidence: [entry(overrides)],
        failedToolCount: 0,
        unavailableDataCount: 0,
      });
      expect(result.level).toBe("medium");
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it("downgrades to low for estimated or unavailable sources and tool failures", () => {
    expect(
      computeAskConfidence({
        evidence: [entry({ quality: "estimated" })],
        failedToolCount: 0,
        unavailableDataCount: 0,
      }).level,
    ).toBe("low");
    expect(
      computeAskConfidence({
        evidence: [entry()],
        failedToolCount: 1,
        unavailableDataCount: 0,
      }),
    ).toEqual({ level: "low", reasons: ["tool_failures"] });
  });

  it("treats missing sources as a medium downgrade and keeps low sticky", () => {
    expect(
      computeAskConfidence({
        evidence: [entry()],
        failedToolCount: 0,
        unavailableDataCount: 2,
      }),
    ).toEqual({ level: "medium", reasons: ["missing_source"] });
    const sticky = computeAskConfidence({
      evidence: [entry({ quality: "estimated" }), entry({ evidenceId: "ev_2" })],
      failedToolCount: 0,
      unavailableDataCount: 1,
    });
    expect(sticky.level).toBe("low");
    expect(sticky.reasons).toContain("estimated_source");
    expect(sticky.reasons).toContain("missing_source");
  });
});
