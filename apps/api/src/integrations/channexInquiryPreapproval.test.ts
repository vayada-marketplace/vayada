import { describe, expect, it, vi } from "vitest";
import {
  createChannexInquiryPreapproval,
  inquiryContextDigest,
} from "./channexInquiryPreapproval.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const details = {
  property_id: propertyId,
  listing_id: "listing-1",
  checkin_date: "2026-12-12",
  nights: 3,
  currency: "EUR",
  adults: 2,
  children: 0,
};
const scope = {
  eventId,
  providerPropertyId: propertyId,
  threadId: "thread-1",
  listingId: "listing-1",
  contextDigest: inquiryContextDigest(details),
};
function event(
  resolved = false,
  resolution: unknown = { type: "preapproval", block_instant_booking: false },
) {
  return {
    data: {
      id: eventId,
      attributes: {
        id: eventId,
        event: "inquiry",
        property_id: propertyId,
        payload: {
          message_thread_id: "thread-1",
          booking_details: { ...details },
          resolved,
          status: resolved ? "preapproval" : "accepted",
          resolution,
        },
      },
    },
  };
}
function setup(...responses: Array<unknown | Error>) {
  const request = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) request.mockRejectedValueOnce(response);
    else
      request.mockResolvedValueOnce(
        response instanceof Response
          ? response
          : new Response(JSON.stringify(response), { status: 200 }),
      );
  }
  return {
    request,
    adapter: createChannexInquiryPreapproval({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "test-only",
      fetch: request,
    }),
  };
}

describe("Airbnb inquiry pre-approval transport", () => {
  it("checks the inquiry before sending exactly the supported non-blocking resolution", async () => {
    const { request, adapter } = setup(event(), event(true));
    expect(await adapter.preapprove(scope)).toEqual({ ok: true, state: "preapproved" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
    const [url, options] = request.mock.calls[1]!;
    expect(String(url)).toBe(`https://staging.channex.io/api/v1/live_feed/${eventId}/resolve`);
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(String(options?.body))).toEqual({
      resolution: { type: "preapproval", block_instant_booking: false },
    });
  });
  it.each(["event", "property", "thread", "listing", "nested-property"])(
    "never sends for mismatched %s",
    async (kind) => {
      const response = event();
      if (kind === "event") response.data.id = propertyId;
      if (kind === "property") response.data.attributes.property_id = eventId;
      if (kind === "thread") response.data.attributes.payload.message_thread_id = "other";
      if (kind === "listing") response.data.attributes.payload.booking_details.listing_id = "other";
      if (kind === "nested-property")
        response.data.attributes.payload.booking_details.property_id = eventId;
      const { request, adapter } = setup(response);
      expect(await adapter.preapprove(scope)).toEqual({
        ok: false,
        failure: "provider_scope_mismatch",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["date", "occupancy", "currency"])("rejects a changed %s", async (field) => {
    const response = event();
    if (field === "date")
      response.data.attributes.payload.booking_details.checkin_date = "2026-12-13";
    if (field === "occupancy") response.data.attributes.payload.booking_details.adults = 3;
    if (field === "currency") response.data.attributes.payload.booking_details.currency = "USD";
    const { request, adapter } = setup(response);
    expect(await adapter.preapprove(scope)).toEqual({ ok: false, failure: "inquiry_changed" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not treat another event kind as an inquiry", async () => {
    const response = event();
    response.data.attributes.event = "reservation_request";
    const { request, adapter } = setup(response);
    expect(await adapter.preapprove(scope)).toEqual({ ok: false, failure: "provider_read_failed" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not submit an already resolved inquiry", async () => {
    const { request, adapter } = setup(event(true, { type: "special_offer", total_price: 100 }));
    expect(await adapter.preapprove(scope)).toEqual({ ok: false, failure: "already_resolved" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not attribute an existing pre-approval to this command", async () => {
    const { request, adapter } = setup(event(true));
    expect(await adapter.preapprove(scope)).toEqual({ ok: false, failure: "already_resolved" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("distinguishes definitive rejection from an uncertain send", async () => {
    const { request, adapter } = setup(
      event(),
      new Response(JSON.stringify({ errors: { code: "validation_error" } }), { status: 422 }),
    );
    expect(await adapter.preapprove(scope)).toEqual({ ok: false, failure: "provider_rejected" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("reconciles a lost response using GET without another POST", async () => {
    const { request, adapter } = setup(event(), new Error("lost"), event(true));
    expect(await adapter.preapprove(scope)).toEqual({ ok: true, state: "preapproved" });
    expect(request.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "POST", "GET"]);
  });
  it("holds an uncertain result instead of automatically sending again", async () => {
    const { request, adapter } = setup(event(), new Error("lost"), event());
    expect(await adapter.preapprove(scope)).toEqual({
      ok: false,
      failure: "decision_outcome_unknown",
    });
    expect(request.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("does not accept a blocking or different resolution as success", async () => {
    const { adapter } = setup(
      event(),
      event(true, { type: "preapproval", block_instant_booking: true }),
    );
    expect(await adapter.preapprove(scope)).toEqual({ ok: true, state: "resolved_other" });
  });
  it("validates input and configuration without leaking credentials", async () => {
    const { request, adapter } = setup();
    expect(await adapter.preapprove({ ...scope, eventId: "../other" })).toEqual({
      ok: false,
      failure: "invalid_request",
    });
    expect(request).not.toHaveBeenCalled();
    expect(() =>
      createChannexInquiryPreapproval({
        apiBaseUrl: "https://untrusted.example",
        apiKey: "secret",
      }),
    ).toThrow("invalid_channex_configuration");
  });
  it("binds the entire reviewed context independent of object key ordering", () => {
    expect(inquiryContextDigest({ a: 1, b: [2, 3] })).toBe(
      inquiryContextDigest({ b: [2, 3], a: 1 }),
    );
    expect(inquiryContextDigest({ a: 1, b: [2, 3] })).not.toBe(
      inquiryContextDigest({ a: 1, b: [3, 2] }),
    );
    expect(() => inquiryContextDigest({ invalid: undefined })).toThrow("invalid_inquiry_context");
  });
});
