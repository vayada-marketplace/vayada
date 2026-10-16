import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MARKER,
  PIN_FILE,
  RECORD_FILE,
  beaconVersion,
  buildReport,
  fetchBeacon,
  fingerprint,
  integrityOf,
  readPin,
  reviewRecord,
  statementDiff,
  surface,
} from "./cloudflare-beacon-drift.mjs";

const OLD = Buffer.from(
  'var a=1;navigator.sendBeacon("https://cloudflareinsights.com/cdn-cgi/rum",x);versions:{js:"2026.10.0"};',
);
const NEW = Buffer.from(
  'var a=2;navigator.sendBeacon("https://cloudflareinsights.com/cdn-cgi/rum",x);fetch("https://example.com/collect");versions:{js:"2026.10.1"};',
);
const live = (bytes) => ({
  bytes,
  etag: 'W/"2026.10.1"',
  lastModified: "Thu, 15 Oct 2026 18:26:54 GMT",
});
const drift = (overrides = {}) =>
  buildReport({
    pin: integrityOf(OLD),
    override: "",
    record: reviewRecord(OLD),
    live: live(NEW),
    ...overrides,
  });

test("the reviewed record is for the pinned beacon and holds no vendor code", () => {
  const record = JSON.parse(readFileSync(RECORD_FILE, "utf8"));
  assert.equal(record.integrity, readPin(readFileSync(PIN_FILE, "utf8")));
  assert.match(record.version, /^\d{4}\.\d+\.\d+$/);
  assert.match(record.statements, /^[\w-]{12}( [\w-]{12})+$/);
  assert.ok(record.statements.split(" ").length > 100);
});

test("reviewRecord keeps the hash, version, counts, URLs and one fingerprint per statement", () => {
  assert.deepEqual(reviewRecord(OLD), {
    version: "2026.10.0",
    size: OLD.length,
    integrity: integrityOf(OLD),
    counts: Object.fromEntries(surface(OLD.toString()).counts),
    urls: ["https://cloudflareinsights.com/cdn-cgi/rum"],
    statements: [
      "var a=1",
      'navigator.sendBeacon("https://cloudflareinsights.com/cdn-cgi/rum",x)',
      'versions:{js:"2026.10.0"}',
    ]
      .map(fingerprint)
      .join(" "),
  });
});

test("readPin rejects a source without a sha384 integrity constant", () => {
  assert.equal(readPin('const integrity = "sha384-abc+/=";'), "sha384-abc+/=");
  assert.throws(() => readPin('const integrity = "sha256-abc";'), /No sha384 integrity/);
  assert.throws(() => readPin("const other = 1;"), /No sha384 integrity/);
});

test("beaconVersion reads the js version and falls back to unknown", () => {
  assert.equal(beaconVersion(OLD.toString()), "2026.10.0");
  assert.equal(beaconVersion("no version here"), "unknown");
  assert.equal(beaconVersion('js:"1.0\n| **x**"'), "unknown");
});

test("statementDiff counts gone reviewed statements and lists new ones, counting duplicates", () => {
  const prints = (...list) => list.map(fingerprint);
  assert.deepEqual(statementDiff(prints("a", "b", "b", "c"), "a;b;c;d;"), {
    before: 4,
    after: 4,
    removed: 1,
    added: 1,
  });
  assert.deepEqual(statementDiff(prints("a", "b"), "a; b ;"), {
    before: 2,
    after: 2,
    removed: 0,
    added: 0,
  });
});

test("surface counts transports and lists endpoints", () => {
  const { urls, counts } = surface(NEW.toString());
  assert.deepEqual(urls, [
    "https://cloudflareinsights.com/cdn-cgi/rum",
    "https://example.com/collect",
  ]);
  assert.equal(Object.fromEntries(counts)["fetch()"], 1);
  assert.equal(Object.fromEntries(counts)["navigator.sendBeacon"], 1);
  assert.deepEqual(surface('x("/cdn-cgi/rum")').urls, ["/cdn-cgi/rum"]);
  const pixel = Object.fromEntries(surface("new Image();new Worker(u);document.write(x)").counts);
  assert.equal(pixel["new Image / workers / document.write"], 3);
});

test("a matching live file produces no report body", () => {
  const report = buildReport({
    pin: integrityOf(NEW),
    override: "",
    record: reviewRecord(NEW),
    live: live(NEW),
  });
  assert.equal(report.matches, true);
  assert.equal(report.body, undefined);
  assert.match(report.summary, /matches the pin/);
});

test("a drifted live file reports versions, the new hash and what changed", () => {
  const report = drift({ repoUrl: "https://github.com/o/r" });
  assert.equal(report.matches, false);
  assert.ok(report.body.startsWith(`${MARKER}\n<!-- live: ${integrityOf(NEW)} -->\n`));
  assert.match(report.body, /\| version \(`js:`\) \| 2026\.10\.0 \| 2026\.10\.1 \|/);
  assert.match(
    report.body,
    new RegExp(`\`\`\`\\n${integrityOf(NEW).replace(/[+/]/g, "\\$&")}\\n\`\`\``),
  );
  assert.match(report.body, /\| fetch\(\) \| 0 \| 1 ⚠️ \|/);
  assert.match(report.body, /\| navigator\.sendBeacon \| 1 \| 1 \|/);
  assert.match(report.body, /\| `https:\/\/example\.com\/collect` \| no \| yes ⚠️ \|/);
  assert.match(report.body, /3 reviewed, 4 now; 2 reviewed statements are gone and 3 are new/);
  assert.doesNotMatch(report.body, /var a=|fetch\("https/);
  assert.match(
    report.body,
    /\(https:\/\/github\.com\/o\/r\/blob\/main\/engineering\/cloudflare-beacon-pin-runbook\.md\)/,
  );
  assert.match(
    report.body,
    /\[Cloudflare Beacon Drift\]\(https:\/\/github\.com\/o\/r\/actions\/workflows\/cloudflare-beacon-drift\.yml\)/,
  );
  assert.doesNotMatch(report.body, /Test run/);
  // Nothing run-specific: tomorrow's run must produce the same body for the same live file.
  assert.equal(drift({ repoUrl: "https://github.com/o/r" }).body, report.body);
});

test("an override run is labelled as a test", () => {
  const override = `sha384-${"A".repeat(64)}`;
  const report = buildReport({
    pin: integrityOf(NEW),
    override,
    record: reviewRecord(NEW),
    live: live(NEW),
  });
  assert.equal(report.matches, false);
  assert.match(report.body, /\*\*Test run\.\*\*/);
  assert.match(report.body, new RegExp(`Expected \\(workflow_dispatch input\\): \`${override}\``));
  assert.match(report.body, /No statement differs from the reviewed version\./);
});

test("a transport the record has no count for is flagged only when the live file uses it", () => {
  const record = reviewRecord(OLD);
  delete record.counts["fetch()"];
  delete record.counts["postMessage"];
  const { body } = drift({ record });
  assert.match(body, /\| fetch\(\) \| not recorded \| 1 ⚠️ \|/);
  assert.match(body, /\| postMessage \| not recorded \| 0 \|/);
});

const response = (status, body, headers = {}) => new Response(body, { status, headers });

test("fetchBeacon retries transient failures, then gives up", async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? response(503, "") : response(200, NEW, { etag: "e" }));
  const fetched = await fetchBeacon({ fetchImpl: flaky, delayMs: 0 });
  assert.equal(calls, 3);
  assert.deepEqual(fetched.bytes, NEW);
  assert.equal(fetched.etag, "e");
  await assert.rejects(
    fetchBeacon({ fetchImpl: async () => response(404, ""), attempts: 2, delayMs: 0 }),
    /HTTP 404/,
  );
});
