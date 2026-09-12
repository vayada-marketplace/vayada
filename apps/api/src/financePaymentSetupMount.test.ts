import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

describe("mounted Finance payment setup", () => {
  it("mounts both protected routes without allowing anonymous reads or writes", async () => {
    const read = vi.fn();
    const write = vi.fn();
    const app = buildApp({
      logger: false,
      financePaymentSetup: {
        readPort: { getPaymentReadiness: read },
        commandPort: { replacePaymentMethods: write },
      },
    });
    try {
      for (const [method, suffix] of [
        ["GET", "payment-readiness"],
        ["PUT", "payment-methods"],
      ] as const) {
        const response = await app.inject({
          method,
          url: `/api/finance/properties/20000000-0000-4000-8000-000000000002/${suffix}`,
        });
        expect(response.statusCode).toBe(401);
      }
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
