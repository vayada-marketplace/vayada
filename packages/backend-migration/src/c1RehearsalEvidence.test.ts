import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildC1RehearsalReport,
  C1_REHEARSAL_CHECKS,
  C1_REHEARSAL_LEGACY_SCHEDULER_JOBS,
  C1_REHEARSAL_PROVIDERS,
  C1_REHEARSAL_REQUIRED_METRICS,
  validateC1RehearsalCheckCoverage,
  type C1RehearsalCheckResult,
} from "./c1RehearsalEvidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const replayManifestPath = join(
  __dirname,
  "../../../engineering/fixtures/c1-staging-rehearsal-replay/manifest.json",
);

describe("C1 rehearsal evidence checks", () => {
  it("covers every cutover-plan metric and provider", () => {
    expect(() => validateC1RehearsalCheckCoverage()).not.toThrow();
    expect(C1_REHEARSAL_CHECKS.map((check) => check.id).sort()).toEqual(
      [...C1_REHEARSAL_REQUIRED_METRICS].sort(),
    );

    for (const check of C1_REHEARSAL_CHECKS) {
      expect(check.sql).toContain("platform.");
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.purpose.length).toBeGreaterThan(0);
    }
  });

  it("tracks missing and unfrozen legacy scheduler evidence separately", () => {
    const rows = C1_REHEARSAL_LEGACY_SCHEDULER_JOBS.map((job) => ({
      job_id: job,
      evidence_status: "passed",
    }));
    rows[0] = {
      job_id: C1_REHEARSAL_LEGACY_SCHEDULER_JOBS[0],
      evidence_status: "failed",
    };
    rows.pop();

    const checks: C1RehearsalCheckResult[] = [
      {
        id: "provider_receipt_counts",
        title: "Provider Receipt Counts",
        rows: C1_REHEARSAL_PROVIDERS.map((provider) => ({ provider })),
      },
      {
        id: "legacy_scheduler_frozen_state",
        title: "Legacy Scheduler Frozen-State Checks",
        rows,
      },
    ];

    const report = buildC1RehearsalReport({
      generatedAt: "2026-06-12T00:00:00.000Z",
      lookbackMinutes: 60,
      checks,
    });

    expect(report.summary.missingProviders).toEqual([]);
    expect(report.summary.unfrozenSchedulerJobs).toEqual([C1_REHEARSAL_LEGACY_SCHEDULER_JOBS[0]]);
    expect(report.summary.missingFrozenSchedulerJobs).toEqual([
      C1_REHEARSAL_LEGACY_SCHEDULER_JOBS[C1_REHEARSAL_LEGACY_SCHEDULER_JOBS.length - 1],
    ]);
  });

  it("covers all dead-letter source kinds and derives provider from receipt/job/event metadata", () => {
    const check = C1_REHEARSAL_CHECKS.find(
      (candidate) => candidate.id === "dead_letters_by_provider_domain",
    );

    expect(check?.sql).toContain("dead_letter.source_kind");
    expect(check?.sql).toContain("webhook.provider");
    expect(check?.sql).toContain("job.job_metadata->>'provider'");
    expect(check?.sql).toContain("outbox.outbox_metadata->>'provider'");
    expect(check?.sql).toContain("domain_event.event_metadata->>'provider'");
    expect(check?.sql).toContain("outbox_domain_event.event_metadata->>'provider'");
    expect(check?.sql).toContain("job_domain_event.event_metadata->>'provider'");
    expect(check?.sql).toContain("dead_letter.webhook_event_id");
    expect(check?.sql).toContain("dead_letter.job_id");
    expect(check?.sql).toContain("dead_letter.outbox_event_id");
    expect(check?.sql).toContain("dead_letter.domain_event_id");
    expect(check?.sql).toContain("job.source_domain_event_id");
  });

  it("ships replay fixtures for Channex, Stripe, and Xendit with expected idempotency keys", async () => {
    const manifest = JSON.parse(await readFile(replayManifestPath, "utf8")) as {
      fixtures: Array<{
        provider: string;
        payloadPath: string;
        expectedReceiptKey: string;
        expectedDomainEventKeys: string[];
        expectedJobKeys: string[];
      }>;
    };

    const providers = new Set(manifest.fixtures.map((fixture) => fixture.provider));
    expect([...providers].sort()).toEqual([...C1_REHEARSAL_PROVIDERS].sort());

    for (const fixture of manifest.fixtures) {
      expect(fixture.expectedReceiptKey).toMatch(/^webhook:(channex|stripe|xendit):/);
      expect(fixture.expectedDomainEventKeys.length).toBeGreaterThan(0);
      expect(fixture.expectedJobKeys.length).toBeGreaterThan(0);

      const payload = JSON.parse(
        await readFile(join(dirname(replayManifestPath), fixture.payloadPath), "utf8"),
      );
      expect(payload).toBeTruthy();
    }
  });
});
