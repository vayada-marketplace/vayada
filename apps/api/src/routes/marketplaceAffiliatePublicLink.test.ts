import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";

const token = `va_${"a".repeat(22)}`;
const redirectUrl = `https://alpenrose.next-booking.vayada.com/?vref=vc_${"b".repeat(22)}`;

describe("dormant public affiliate link route", () => {
  it("is absent from the runtime app until the launch gates are satisfied", async () => {
    const app = buildApp({ logger: false });
    try {
      expect((await app.inject({ method: "GET", url: `/r/${token}` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("redirects a valid visit without caching or forwarding a referrer", async () => {
    const visit = vi.fn().mockResolvedValue({ status: "ready", redirectUrl });
    const consumeQuota = vi.fn().mockResolvedValue({ allowed: true });
    const app = buildApp({
      logger: false,
      marketplaceAffiliatePublicLink: { visit, consumeQuota },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/r/${token}?campaign=instagram.reel-1`,
        headers: { referer: "https://instagram.com/post/123" },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(redirectUrl);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(visit).toHaveBeenCalledWith({
        publicToken: token,
        campaignLabel: "instagram.reel-1",
        source: "instagram",
      });
      expect(consumeQuota).toHaveBeenCalledWith({
        publicToken: token,
        requesterIp: "127.0.0.1",
      });
    } finally {
      await app.close();
    }
  });

  it("does not write a visit when the quota is exhausted or the link is invalid", async () => {
    const visit = vi.fn();
    const consumeQuota = vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const app = buildApp({
      logger: false,
      marketplaceAffiliatePublicLink: { visit, consumeQuota },
    });
    try {
      const limited = await app.inject({ method: "GET", url: `/r/${token}` });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(visit).not.toHaveBeenCalled();
      const invalid = await app.inject({ method: "GET", url: "/r/not-a-link" });
      expect(invalid.statusCode).toBe(404);
      const probe = await app.inject({ method: "HEAD", url: `/r/${token}` });
      expect(probe.statusCode).toBe(404);
      expect(visit).not.toHaveBeenCalled();
      expect(consumeQuota).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects an unsafe destination and hides link tokens from request logs", async () => {
    const logs: string[] = [];
    const visit = vi.fn().mockResolvedValue({
      status: "ready",
      redirectUrl: "https://attacker.example/?vref=vc_secret",
    });
    const app = buildApp({
      logger: { level: "info", stream: { write: (line) => logs.push(line) } },
      marketplaceAffiliatePublicLink: {
        visit,
        consumeQuota: async () => ({ allowed: true }),
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: `/r/${token}` });
      expect(response.statusCode).toBe(500);
      const arrival = await app.inject({
        method: "GET",
        url: `/nonexistent?vref=vc_${"c".repeat(22)}`,
      });
      expect(arrival.statusCode).toBe(404);
      await app.inject({ method: "GET", url: `/r%2F${token}` });
      await app.inject({
        method: "GET",
        url: `/nonexistent?%76ref=vc_${"d".repeat(22)}`,
      });
      expect(logs.join("")).not.toContain(token);
      expect(logs.join("")).not.toContain("vc_secret");
      expect(logs.join("")).not.toContain(`vc_${"c".repeat(22)}`);
      expect(logs.join("")).not.toContain(`vc_${"d".repeat(22)}`);
    } finally {
      await app.close();
    }
  });
});
