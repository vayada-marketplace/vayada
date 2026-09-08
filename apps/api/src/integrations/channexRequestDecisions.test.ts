import { describe, expect, it, vi } from "vitest";
import {
  createChannexRequestDecisions,
  type ChannexRequestScope,
} from "./channexRequestDecisions.js";

const scope: ChannexRequestScope = {
  eventId: "9a52c05b-ea75-4fad-aaab-21741c3be253",
  providerPropertyId: "3e8f5809-3a1e-4f80-90a2-38d33e37b317",
  kind: "reservation_request",
};
function event(state = "pending", kind = scope.kind) {
  return {
    data: {
      id: scope.eventId,
      attributes: {
        property_id: scope.providerPropertyId,
        event: kind,
        payload: { resolved: state !== "pending", resolution: state, status: state.toUpperCase() },
      },
    },
  };
}
function harness(...responses: unknown[]) {
  const request = vi.fn<typeof fetch>();
  for (const value of responses) {
    if (value instanceof Error) request.mockRejectedValueOnce(value);
    else request.mockResolvedValueOnce(value instanceof Response ? value : Response.json(value));
  }
  return {
    request,
    api: createChannexRequestDecisions({
      apiBaseUrl: "https://staging.channex.io/api/v1",
      apiKey: "private-test-key",
      fetch: request,
    }),
  };
}

describe("Channex request decision transport", () => {
  it.each([
    ["reservation_request", "accept", { accept: true }],
    ["reservation_request", "decline", { accept: false, reason: "not_comfortable" }],
    ["alteration_request", "accept", { accept: "accept" }],
    ["alteration_request", "decline", { accept: "decline" }],
  ] as const)("serializes %s %s and returns provider outcome", async (kind, action, resolution) => {
    const state = action === "accept" ? "accepted" : "declined";
    const { api, request } = harness(event("pending", kind), event(state, kind));
    expect(await api.resolve({ ...scope, kind }, { action })).toEqual({ ok: true, state });
    expect(request).toHaveBeenCalledTimes(2);
    const [url, init] = request.mock.calls[1]!;
    expect(String(url)).toBe(
      `https://staging.channex.io/api/v1/live_feed/${scope.eventId}/resolve`,
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      body: JSON.stringify({ resolution }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the supplied reservation decline reason", async () => {
    const { api, request } = harness(event(), event("declined"));
    await api.resolve(scope, { action: "decline", reason: "dates_not_available" });
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
      resolution: { accept: false, reason: "dates_not_available" },
    });
  });

  it.each(["declined", "accepted", "unexpected"])(
    "does not send when already resolved as %s",
    async (state) => {
      const { api, request } = harness(event(state));
      expect(await api.resolve(scope, { action: "accept" })).toEqual({
        ok: true,
        state: state === "unexpected" ? "resolved_unknown" : state,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("reports the actual opposite outcome returned by resolve", async () => {
    const { api } = harness(event(), event("declined"));
    expect(await api.resolve(scope, { action: "accept" })).toEqual({ ok: true, state: "declined" });
  });

  it.each([new Error("private provider failure"), new Response("secret", { status: 503 }), null])(
    "reconciles an ambiguous POST without resending",
    async (failed) => {
      const { api, request } = harness(event(), failed, event("accepted"));
      expect(await api.resolve(scope, { action: "accept" })).toEqual({
        ok: true,
        state: "accepted",
      });
      expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
    },
  );

  it.each([event(), new Error("private-test-key")])(
    "keeps unresolved delivery unknown",
    async (readback) => {
      const { api, request } = harness(event(), new Error("secret"), readback);
      expect(await api.resolve(scope, { action: "accept" })).toEqual({
        ok: false,
        failure: "decision_outcome_unknown",
      });
      expect(request).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["property", "id", "kind"])("rejects a mismatched %s before POST", async (mismatch) => {
    const data = event();
    if (mismatch === "id") data.data.id = "00000000-0000-4000-8000-000000000001";
    if (mismatch === "property")
      data.data.attributes.property_id = "00000000-0000-4000-8000-000000000001";
    if (mismatch === "kind") data.data.attributes.event = "alteration_request";
    const { api, request } = harness(data);
    expect(await api.resolve(scope, { action: "accept" })).toEqual({
      ok: false,
      failure: "provider_scope_mismatch",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recognizes alteration withdrawal without another decision", async () => {
    const { api, request } = harness(event("canceled", "alteration_request"));
    expect(
      await api.resolve({ ...scope, kind: "alteration_request" }, { action: "decline" }),
    ).toEqual({ ok: true, state: "withdrawn" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates runtime inputs without making requests", async () => {
    const { api, request } = harness();
    expect(await api.read({ ...scope, eventId: "../other" })).toEqual({
      ok: false,
      failure: "invalid_request",
    });
    expect(
      await api.resolve(
        { ...scope, kind: "alteration_request" },
        { action: "decline", reason: "not_comfortable" },
      ),
    ).toEqual({ ok: false, failure: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([null, {}, new Response("secret", { status: 401 }), new Error("private-test-key")])(
    "fails closed on invalid or unavailable initial reads",
    async (response) => {
      const { api, request } = harness(response);
      expect(await api.resolve(scope, { action: "accept" })).toEqual({
        ok: false,
        failure: "provider_read_failed",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "https://attacker.test",
    "https://app.channex.io@attacker.test",
    "http://app.channex.io",
    "https://app.channex.io/other",
    "not a URL",
  ])("rejects unsafe configuration without exposing it", (apiBaseUrl) => {
    expect(() => createChannexRequestDecisions({ apiBaseUrl, apiKey: "secret" })).toThrow(
      "invalid_channex_configuration",
    );
  });
});
