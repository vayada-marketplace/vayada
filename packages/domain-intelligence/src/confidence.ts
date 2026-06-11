import type { AskConfidence } from "./ask.js";
import type { AskEvidenceEntry } from "./evidence.js";

export type AskConfidenceSignals = {
  /** Evidence entries actually cited by the composed answer. */
  evidence: AskEvidenceEntry[];
  /** Count of planned tools that errored or were denied. */
  failedToolCount: number;
  /** Count of material unavailable-data items attached to the answer. */
  unavailableDataCount: number;
};

const SMALL_SAMPLE_THRESHOLD = 10;

/**
 * Confidence is computed from evidence metadata per the VAY-601 architecture
 * confidence principles — never from model self-assessment. Reasons explain
 * every downgrade so the answer can say why confidence is not high.
 */
export function computeAskConfidence(signals: AskConfidenceSignals): AskConfidence {
  if (signals.evidence.length === 0) {
    return { level: "unknown", reasons: ["no_cited_evidence"] };
  }

  const reasons = new Set<string>();
  let level: "high" | "medium" | "low" = "high";
  const downgrade = (target: "medium" | "low", reason: string) => {
    reasons.add(reason);
    if (target === "low" || level === "low") level = "low";
    else level = "medium";
  };

  for (const entry of signals.evidence) {
    if (entry.freshness.status === "unavailable" || entry.quality === "unavailable") {
      downgrade("low", "unavailable_source");
    } else if (entry.freshness.status === "stale" || entry.quality === "stale") {
      downgrade("medium", "stale_source");
    } else if (entry.freshness.status === "unknown") {
      downgrade("medium", "unknown_freshness");
    }
    if (entry.quality === "estimated") downgrade("low", "estimated_source");
    if (entry.quality === "partial") downgrade("medium", "partial_source");
    if (entry.quality === "hotelier_entered") downgrade("medium", "hotelier_entered_source");
    if (entry.sampleSize !== undefined && entry.sampleSize < SMALL_SAMPLE_THRESHOLD) {
      downgrade("medium", "small_sample");
    }
  }

  if (signals.failedToolCount > 0) downgrade("low", "tool_failures");
  if (signals.unavailableDataCount > 0) downgrade("medium", "missing_source");

  if (level === "high") {
    return { level, reasons: ["fresh_internal_metrics", "complete_source"] };
  }
  return { level, reasons: [...reasons] };
}
