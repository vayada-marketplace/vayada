import { expect, it, vi } from "vitest";
import { createChannexInboxProviderActions } from "./channexInboxProviderActions.js";
import { airbnbInquiryEvidence } from "../domains/airbnbInquiryEvidence.js";
const property = "22222222-2222-4222-8222-222222222222";
const eventId = "11111111-1111-4111-8111-111111111111";
const details = {
  property_id: property,
  listing_id: "listing",
  checkin_date: "2030-12-12",
  nights: 3,
  currency: "EUR",
  adults: 2,
  children: 0,
};
const inquiry = airbnbInquiryEvidence({
  inquiry: true,
  providerChannel: "airbnb",
  providerPropertyId: property,
  threadId: "thread",
  eventId,
  bookingDetails: details,
})!;
const event = (resolved: boolean) => ({
  data: {
    id: eventId,
    attributes: {
      property_id: property,
      event: "inquiry",
      payload: {
        message_thread_id: "thread",
        booking_details: details,
        resolved,
        status: "preapproval",
        resolution: { type: "preapproval", block_instant_booking: false },
      },
    },
  },
});
it("worker recovery reads only and holds an unresolved send", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(event(false))));
  const execute = createChannexInboxProviderActions({
    apiBaseUrl: "https://staging.channex.io",
    apiKey: "test",
    fetch,
  });
  expect(
    await execute({ action: "airbnb_preapprove", providerConversationId: "thread", inquiry }, true),
  ).toEqual({ ok: false, failure: "ambiguous_provider_outcome" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
});
it("distinguishes a recovered success from an already-resolved new command", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(event(true))));
  const execute = createChannexInboxProviderActions({
    apiBaseUrl: "https://staging.channex.io",
    apiKey: "test",
    fetch,
  });
  const input = { action: "airbnb_preapprove" as const, providerConversationId: "thread", inquiry };
  expect(await execute(input, true)).toEqual({ ok: true, providerReference: eventId });
  expect(await execute(input)).toEqual({ ok: false, failure: "provider_rejected" });
  expect(fetch.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
});
it("cannot send for missing or foreign conversation evidence", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const execute = createChannexInboxProviderActions({
    apiBaseUrl: "https://staging.channex.io",
    apiKey: "test",
    fetch,
  });
  for (const proof of [undefined, inquiry])
    expect(
      await execute({
        action: "airbnb_preapprove",
        providerConversationId: "foreign",
        inquiry: proof,
      }),
    ).toEqual({ ok: false, failure: "invalid_delivery_payload" });
  expect(fetch).not.toHaveBeenCalled();
});
