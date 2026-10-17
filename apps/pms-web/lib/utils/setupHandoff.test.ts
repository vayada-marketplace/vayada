import { describe, expect, it, vi } from "vitest";
import { BrowserAuthHandoffError } from "@vayada/product-onboarding";
import { resolveSharedHotelSetupHandoff, sharedHotelSetupTargetPath } from "./setupHandoff";

const BASE = "https://admin.booking.example";
const TARGET = "/setup?entryProduct=pms&returnProduct=pms&returnTo=%2Fdashboard&mode=add";

describe("sharedHotelSetupTargetPath", () => {
  it("keeps a safe relative path", () => {
    expect(sharedHotelSetupTargetPath(TARGET, BASE)).toBe(TARGET);
  });

  it("strips the Booking Admin origin from a guard decision", () => {
    expect(sharedHotelSetupTargetPath(`${BASE}${TARGET}`, BASE)).toBe(TARGET);
  });

  it.each([
    "https://attacker.example/setup?entryProduct=pms",
    "//attacker.example/setup",
    `${BASE}/setup#code=abc`,
    "javascript:alert(1)",
    "",
  ])("rejects %s", (value) => {
    expect(sharedHotelSetupTargetPath(value, BASE)).toBeNull();
  });
});

describe("resolveSharedHotelSetupHandoff", () => {
  it("hands the session over when the PMS session can mint a code", async () => {
    const create = vi.fn().mockResolvedValue(`${BASE}/handoff#code=${"a".repeat(40)}`);
    await expect(
      resolveSharedHotelSetupHandoff({
        targetPath: TARGET,
        csrfToken: "csrf",
        baseUrl: BASE,
        create,
      }),
    ).resolves.toEqual({ kind: "handoff", destination: `${BASE}/handoff#code=${"a".repeat(40)}` });
    expect(create).toHaveBeenCalledWith({
      csrfToken: "csrf",
      sourceSurface: "pms-web",
      targetPath: TARGET,
      targetSurface: "booking-admin",
    });
  });

  it("sends the user through Booking Admin's login without a CSRF token", async () => {
    const create = vi.fn();
    await expect(
      resolveSharedHotelSetupHandoff({
        targetPath: TARGET,
        csrfToken: null,
        baseUrl: BASE,
        create,
      }),
    ).resolves.toEqual({
      kind: "reauthenticate",
      destination: `${BASE}/login?returnTo=${encodeURIComponent(TARGET)}`,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to Booking Admin's login after a terminal handoff failure", async () => {
    const create = vi.fn().mockRejectedValue(new BrowserAuthHandoffError("expired", false));
    await expect(
      resolveSharedHotelSetupHandoff({
        targetPath: TARGET,
        csrfToken: "csrf",
        baseUrl: BASE,
        create,
      }),
    ).resolves.toEqual({
      kind: "reauthenticate",
      destination: `${BASE}/login?returnTo=${encodeURIComponent(TARGET)}`,
    });
  });

  it("asks for a retry when the handoff is temporarily unavailable", async () => {
    const create = vi.fn().mockRejectedValue(new BrowserAuthHandoffError("later", true));
    await expect(
      resolveSharedHotelSetupHandoff({
        targetPath: TARGET,
        csrfToken: "csrf",
        baseUrl: BASE,
        create,
      }),
    ).resolves.toEqual({ kind: "retryable" });
  });

  it("asks for a retry when the Booking Admin origin is not configured", async () => {
    await expect(
      resolveSharedHotelSetupHandoff({ targetPath: TARGET, csrfToken: null, baseUrl: "not a url" }),
    ).resolves.toEqual({ kind: "retryable" });
  });
});
