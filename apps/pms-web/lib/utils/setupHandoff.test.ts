import { describe, expect, it, vi } from "vitest";
import { BrowserAuthHandoffError } from "@vayada/product-onboarding";
import { ApiErrorResponse } from "@/services/api/client";
import { AuthStateError } from "@/services/auth";
import {
  classifyPmsSessionFailure,
  pmsLoginUrlForSetup,
  resolveSharedHotelSetupHandoff,
} from "./setupHandoff";

const BASE = "https://admin.booking.example";
const TARGET = "/setup?entryProduct=pms&returnProduct=pms&returnTo=%2Fdashboard&mode=add";

describe("classifyPmsSessionFailure", () => {
  it.each([401, 403, 404])("treats a %s session read as signed out", (status) => {
    expect(classifyPmsSessionFailure(new ApiErrorResponse(status, { detail: "no" }))).toBe(
      "signed_out",
    );
  });

  it("treats an auth state answer as signed out", () => {
    expect(
      classifyPmsSessionFailure(
        new AuthStateError(409, { state: "email_verification_required", message: "verify" }),
      ),
    ).toBe("signed_out");
  });

  it.each([new ApiErrorResponse(503, { detail: "down" }), new TypeError("fetch failed"), "boom"])(
    "treats %s as temporarily unavailable",
    (error) => {
      expect(classifyPmsSessionFailure(error)).toBe("unavailable");
    },
  );
});

describe("pmsLoginUrlForSetup", () => {
  it("returns to the alias after sign-in", () => {
    expect(pmsLoginUrlForSetup("/setup?mode=add")).toBe("/login?returnTo=%2Fsetup%3Fmode%3Dadd");
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

  it("passes an abort signal to the handoff request", async () => {
    const create = vi.fn().mockResolvedValue(`${BASE}/handoff#code=${"a".repeat(40)}`);
    const controller = new AbortController();
    await resolveSharedHotelSetupHandoff({
      targetPath: TARGET,
      csrfToken: "csrf",
      baseUrl: BASE,
      signal: controller.signal,
      create,
    });
    expect(create.mock.calls[0]?.[0]).toHaveProperty("fetcher");
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

  it("surfaces an unexpected handoff error instead of redirecting", async () => {
    const create = vi.fn().mockRejectedValue(new TypeError("bug"));
    await expect(
      resolveSharedHotelSetupHandoff({
        targetPath: TARGET,
        csrfToken: "csrf",
        baseUrl: BASE,
        create,
      }),
    ).rejects.toThrow("bug");
  });

  it("asks for a retry and logs when the Booking Admin origin is not configured", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      resolveSharedHotelSetupHandoff({ targetPath: TARGET, csrfToken: null, baseUrl: "not a url" }),
    ).resolves.toEqual({ kind: "retryable" });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
