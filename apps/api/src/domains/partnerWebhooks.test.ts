import { createHmac } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { installPostgresPoolRuntime } from "../platform/postgresRuntime.js";
import {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
  deriveWebhookSigningSecret,
  parseWebhookSigningKey,
  partnerJobPoolConfig,
  webhookSignature,
} from "./partnerWebhooks.js";

describe("partner webhook signing and retries (VAY-2438)", () => {
  it("signs t.<raw body> with HMAC-SHA256 the way the contract says", () => {
    const body = '{"id":"e1","type":"booking.confirmed"}';
    const signature = webhookSignature("vyp_ws_secret", body, 1_764_000_000);
    expect(signature).toBe(
      `t=1764000000,v1=${createHmac("sha256", "vyp_ws_secret").update(`1764000000.${body}`).digest("hex")}`,
    );
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("derives one stable secret per app and secret version, never the same across apps", () => {
    const key = Buffer.alloc(32, 7);
    const a1 = deriveWebhookSigningSecret(key, "partner_a", 1);
    expect(a1).toMatch(/^vyp_ws_[A-Za-z0-9_-]{43}$/);
    expect(deriveWebhookSigningSecret(key, "partner_a", 1)).toBe(a1);
    expect(deriveWebhookSigningSecret(key, "partner_a", 2)).not.toBe(a1);
    expect(deriveWebhookSigningSecret(key, "partner_b", 1)).not.toBe(a1);
    expect(deriveWebhookSigningSecret(Buffer.alloc(32, 8), "partner_a", 1)).not.toBe(a1);
  });

  it("retries after 1 minute, 5 minutes, 30 minutes and 2 hours, then every 6 hours for 3 days", () => {
    expect(RETRY_DELAYS_SECONDS.slice(0, 4)).toEqual([60, 300, 1_800, 7_200]);
    expect(RETRY_DELAYS_SECONDS.slice(4)).toEqual(Array(12).fill(6 * 3_600));
    expect(RETRY_DELAYS_SECONDS.slice(4).reduce((sum, delay) => sum + delay, 0)).toBe(3 * 86_400);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(17);
  });

  it("takes a signing key of at least 32 bytes, or none", () => {
    expect(parseWebhookSigningKey(undefined)).toBeNull();
    expect(parseWebhookSigningKey("  ")).toBeNull();
    expect(parseWebhookSigningKey(Buffer.alloc(32, 1).toString("base64"))?.length).toBe(32);
    expect(() => parseWebhookSigningKey(Buffer.alloc(16, 1).toString("base64"))).toThrow(
      /32 bytes/,
    );
  });

  it("gives the sweep and the delivery one connection each, apart from the shared pool, in production", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const connectionString = "postgresql://example/target";
    const general = new postgres.Pool({ connectionString });
    // What the jobs had before: the same settings as the general pool, so the runtime handed out the
    // general pool itself (max 8, shared with requests) and ignored max: 2.
    const before = new postgres.Pool({ connectionString, max: 2 });
    const sweep = new postgres.Pool(partnerJobPoolConfig(connectionString, "sweep"));
    const delivery = new postgres.Pool(partnerJobPoolConfig(connectionString, "delivery"));
    try {
      expect(before.options.max).toBe(8);
      expect(sweep.options.max).toBe(1);
      expect(delivery.options.max).toBe(1);
      expect(runtime.snapshot()).toMatchObject({ physicalPoolCount: 3, maxConnections: 10 });
      expect(partnerJobPoolConfig(connectionString, "sweep")).toEqual({
        connectionString,
        max: 1,
        application_name: "vayada-partner-sweep",
        statement_timeout: 30_000,
        lock_timeout: 5_000,
        idle_in_transaction_session_timeout: 60_000,
      });
    } finally {
      await Promise.all([general, before, sweep, delivery].map((pool) => pool.end()));
      await runtime.close();
    }
  });
});
