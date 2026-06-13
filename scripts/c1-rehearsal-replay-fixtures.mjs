#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const fixtureDir = join(repoRoot, "engineering/fixtures/c1-staging-rehearsal-replay");
const manifestPath = join(fixtureDir, "manifest.json");

function usage() {
  console.log(`Usage:
  node scripts/c1-rehearsal-replay-fixtures.mjs --list
  node scripts/c1-rehearsal-replay-fixtures.mjs --fixture <id> --base-url <url> [--send] [--twice]
  node scripts/c1-rehearsal-replay-fixtures.mjs --provider <provider> --base-url <url> [--send] [--twice]
  node scripts/c1-rehearsal-replay-fixtures.mjs --all --base-url <url> [--send] [--twice]

Options:
  --send       Perform HTTP POST requests. Without this flag the script prints a dry run.
  --twice      Replay each selected fixture twice to exercise idempotency.
  --base-url   Target webhook base URL, or set C1_REHEARSAL_WEBHOOK_BASE_URL.

Send safety:
  Dry runs never require host allowlisting.
  --send only allows local hosts by default:
    localhost, *.localhost, 127.0.0.1, ::1
  Set C1_REHEARSAL_ALLOW_SEND_TO_HOST=<host> to allow one exact additional host.

Required env for --send:
  STRIPE_WEBHOOK_SECRET      Used to generate Stripe-Signature for Stripe fixtures.
  XENDIT_WEBHOOK_SECRET      Sent as x-callback-token for Xendit fixtures.
  CHANNEX_WEBHOOK_SECRET     Sent as x-vayada-webhook-token for Channex fixtures.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    all: false,
    fixtureId: "",
    provider: "",
    baseUrl: process.env.C1_REHEARSAL_WEBHOOK_BASE_URL ?? "",
    list: false,
    send: false,
    twice: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--all") parsed.all = true;
    else if (arg === "--fixture" && args[i + 1]) parsed.fixtureId = args[++i];
    else if (arg === "--provider" && args[i + 1]) parsed.provider = args[++i];
    else if (arg === "--base-url" && args[i + 1]) parsed.baseUrl = args[++i];
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--send") parsed.send = true;
    else if (arg === "--twice") parsed.twice = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
      process.exit(1);
    }
  }

  return parsed;
}

function selectorModeCount(args) {
  return [args.all, Boolean(args.fixtureId), Boolean(args.provider), args.list].filter(Boolean)
    .length;
}

function validateSelectorMode(args) {
  const count = selectorModeCount(args);
  if (count !== 1) {
    throw new Error(
      "Select exactly one of --all, --provider <provider>, --fixture <id>, or --list.",
    );
  }
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function resolveFixturePayloadPath(payloadPath) {
  const root = resolve(fixtureDir);
  const candidate = resolve(root, payloadPath);
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Fixture payloadPath escapes fixture directory: ${payloadPath}`);
  }
  return candidate;
}

function selectFixtures(manifest, args) {
  if (args.all) return manifest.fixtures;
  if (args.fixtureId) {
    const fixture = manifest.fixtures.find((candidate) => candidate.id === args.fixtureId);
    if (!fixture) throw new Error(`Unknown fixture id: ${args.fixtureId}`);
    return [fixture];
  }
  if (args.provider) {
    const fixtures = manifest.fixtures.filter((fixture) => fixture.provider === args.provider);
    if (fixtures.length === 0) throw new Error(`Unknown provider: ${args.provider}`);
    return fixtures;
  }
  throw new Error("Select --all, --provider <provider>, --fixture <id>, or --list.");
}

function stripeSignature(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function headersForFixture(fixture, payload, send) {
  const headers = {
    "content-type": "application/json",
    "x-vayada-rehearsal-ticket": "VAY-793",
  };

  if (fixture.provider === "stripe") {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (send && !secret) throw new Error("STRIPE_WEBHOOK_SECRET is required for Stripe replay.");
    headers["stripe-signature"] = secret
      ? stripeSignature(payload, secret)
      : "dry-run-stripe-signature";
  } else if (fixture.provider === "xendit") {
    const secret = process.env.XENDIT_WEBHOOK_SECRET;
    if (send && !secret) throw new Error("XENDIT_WEBHOOK_SECRET is required for Xendit replay.");
    headers["x-callback-token"] = secret ?? "dry-run-xendit-token";
  } else if (fixture.provider === "channex") {
    const secret = process.env.CHANNEX_WEBHOOK_SECRET;
    if (send && !secret) throw new Error("CHANNEX_WEBHOOK_SECRET is required for Channex replay.");
    headers["x-vayada-webhook-token"] = secret ?? "dry-run-channex-token";
  }

  return headers;
}

function isAllowedSendHost(hostname) {
  const normalized = hostname.toLowerCase();
  const explicitHost = process.env.C1_REHEARSAL_ALLOW_SEND_TO_HOST?.toLowerCase();
  if (explicitHost && normalized === explicitHost) return true;

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function assertSendAllowed(baseUrl) {
  const url = new URL(baseUrl);
  if (isAllowedSendHost(url.hostname)) return;

  throw new Error(
    [
      `Refusing --send to non-local host "${url.hostname}".`,
      "Use a local base URL, dry-run without --send, or set",
      "C1_REHEARSAL_ALLOW_SEND_TO_HOST=<host> for an explicit one-host override.",
    ].join(" "),
  );
}

async function replayFixture(fixture, args) {
  const payload = await readFile(resolveFixturePayloadPath(fixture.payloadPath), "utf8");
  const url = new URL(
    fixture.endpointPath,
    args.baseUrl.endsWith("/") ? args.baseUrl : `${args.baseUrl}/`,
  );
  const attempts = args.twice ? 2 : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const headers = headersForFixture(fixture, payload, args.send);
    if (!args.send) {
      console.log(
        JSON.stringify(
          {
            mode: "dry_run",
            fixture: fixture.id,
            attempt,
            method: "POST",
            url: url.toString(),
            headers: redactHeaders(headers),
            expectedReceiptKey: fixture.expectedReceiptKey,
            expectedDomainEventKeys: fixture.expectedDomainEventKeys,
            expectedJobKeys: fixture.expectedJobKeys,
          },
          null,
          2,
        ),
      );
      continue;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
    });
    const responseBody = await response.text();
    console.log(
      JSON.stringify({
        mode: "sent",
        fixture: fixture.id,
        attempt,
        status: response.status,
        ok: response.ok,
        responseBody,
      }),
    );
    if (!response.ok) process.exitCode = 1;
  }
}

function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (key.includes("token") || key.includes("signature")) return [key, "<redacted>"];
      return [key, value];
    }),
  );
}

const args = parseArgs(process.argv);

try {
  validateSelectorMode(args);
  if (!args.list && !args.baseUrl) {
    throw new Error("--base-url or C1_REHEARSAL_WEBHOOK_BASE_URL is required.");
  }
  if (args.send && !args.list) assertSendAllowed(args.baseUrl);
} catch (error) {
  console.error(`Error: ${error.message}`);
  usage();
  process.exit(1);
}

const manifest = await loadManifest();

if (args.list) {
  for (const fixture of manifest.fixtures) {
    console.log(`${fixture.id}\t${fixture.provider}\t${fixture.eventType}\t${fixture.payloadPath}`);
  }
  process.exit(0);
}

for (const fixture of selectFixtures(manifest, args)) {
  await replayFixture(fixture, args);
}
