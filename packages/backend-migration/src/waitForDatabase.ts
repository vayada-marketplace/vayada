import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";

// Failures worth waiting out at boot: the server is unreachable, restarting, shutting down or
// out of connection slots. Authentication and configuration errors fail at once.
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "08000",
  "08001",
  "08003",
  "08006",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);
// pg reports its own connect timeout as "timeout expired" with no code: a host that silently
// drops packets (failover, security group) fails this way rather than with a socket error.
const TRANSIENT_MESSAGE =
  /^(?:connection terminated unexpectedly|connection terminated due to connection timeout|query read timeout|timeout expired)$/i;
const MAX_ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 10_000;

export type WaitForDatabaseOptions = {
  connectionString: string;
  timeoutMs: number;
  log?: (message: string) => void;
  probe?: (connectionString: string, timeoutMs: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export function isTransientDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === "string" && TRANSIENT_CODES.has(code)) ||
    (typeof message === "string" && TRANSIENT_MESSAGE.test(message))
  );
}

/** Retries a connect-and-SELECT-1 probe with backoff until it succeeds or timeoutMs runs out. */
export async function waitForDatabase(options: WaitForDatabaseOptions): Promise<void> {
  const {
    log = console.log,
    probe = probeDatabase,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;
  const deadline = now() + options.timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    const remaining = Math.max(deadline - now(), 1_000);
    try {
      await probe(options.connectionString, Math.min(remaining, MAX_ATTEMPT_TIMEOUT_MS));
      if (attempt > 1) log(`Database reachable after ${attempt} attempts.`);
      return;
    } catch (error) {
      const delay = Math.min(1_000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      if (!isTransientDatabaseError(error) || now() + delay >= deadline) throw error;
      // Only the error code: messages can carry the database address.
      log(`Database unavailable (${errorCode(error)}); retrying in ${delay / 1_000}s.`);
      await sleep(delay);
    }
  }
}

async function probeDatabase(connectionString: string, timeoutMs: number): Promise<void> {
  const client = new pg.Client({
    connectionString: normalizePgConnectionString(connectionString),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  // A connection lost after connect fails the query below instead of raising an 'error' event.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The error code, or a known address-free pg message; never the raw message. */
export function errorCode(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === "string") return code;
  return typeof message === "string" && TRANSIENT_MESSAGE.test(message) ? message : "unknown";
}
