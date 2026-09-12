import { describe, expect, it, vi } from "vitest";
import {
  restoreStripeSetupReturnContext as restore,
  saveStripeSetupReturnContext as save,
} from "./stripeSetupReturnContext";
function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const start =
  "https://marketplace.test/setup?propertyId=p&step=payments&entryProduct=pms&returnProduct=pms&returnTo=%2Fsettings%3Fx%3D1&recovery=pms-calendar&token=excluded";
const end = "https://marketplace.test/setup?propertyId=p&step=payments&stripe=return";
describe("hosted Stripe navigation context", () => {
  it("restores safe scoped navigation once, excluding unrelated parameters", () => {
    const s = store();
    save(s, "org", "p", start);
    expect(restore(s, "other", "p", end)).toBeNull();
    const result = restore(s, "org", "p", end)!;
    expect(result).toContain("returnTo=%2Fsettings%3Fx%3D1");
    expect(result).toContain("recovery=pms-calendar");
    expect(result).not.toContain("token");
    expect(restore(s, "org", "p", end)).toBeNull();
  });
  it("does not restore across property, on ordinary entry, or over explicit context", () => {
    const s = store();
    save(s, "org", "p", start);
    expect(restore(s, "org", "other", end)).toBeNull();
    expect(restore(s, "org", "p", start)).toBeNull();
    expect(restore(s, "org", "p", end + "&returnTo=%2Fexplicit")).toContain("returnTo=%2Fexplicit");
  });
  it("expires old context and fails safely without storage", () => {
    const s = store();
    save(s, "org", "p", start);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600001);
    expect(restore(s, "org", "p", end)).toBeNull();
    now.mockRestore();
    const unavailable = {
      ...s,
      getItem: () => {
        throw new Error("disabled");
      },
    };
    expect(restore(unavailable, "org", "p", end)).toBeNull();
  });
});
