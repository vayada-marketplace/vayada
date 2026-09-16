import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createChannexAlterationFeed } from "./channexAlterationFeed.js";
const propertyId = randomUUID(),
  eventId = randomUUID();
const event = (resolved = false) => ({
  id: eventId,
  attributes: {
    property_id: propertyId,
    event: "alteration_request",
    payload: { resolved, bms: { amount: "200.00" } },
  },
});
function fixture(value: unknown) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
  return {
    request,
    api: createChannexAlterationFeed({
      apiBaseUrl: "https://staging.channex.io/api/v1",
      apiKey: "private-test-key",
      fetch: request,
    }),
  };
}
it("discovers only unresolved events with bounded property-filtered pages", async () => {
  const { api, request } = fixture({ data: [event(), event(true)] });
  expect(await api.list(propertyId, 2)).toEqual({ eventIds: [eventId], hasMore: false });
  const url = new URL(String(request.mock.calls[0]![0]));
  expect(url.origin).toBe("https://staging.channex.io");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    "filter[property_id]": propertyId,
    "filter[event]": "alteration_request",
    "pagination[page]": "2",
    "pagination[limit]": "20",
    "order[inserted_at]": "desc",
  });
  expect(request.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error" });
});
it("continues a full page and requires a fresh detail read for the proposal", async () => {
  expect(
    await fixture({ data: Array.from({ length: 20 }, () => event(true)) }).api.list(propertyId, 1),
  ).toEqual({ eventIds: [], hasMore: true });
  const { api, request } = fixture({ data: event() });
  expect(await api.read(propertyId, eventId)).toEqual({ data: event() });
  expect(String(request.mock.calls[0]![0])).toBe(
    `https://staging.channex.io/api/v1/live_feed/${eventId}`,
  );
  expect(await fixture({ data: event(true) }).api.read(propertyId, eventId)).toBeNull();
});
it.each(["property", "kind", "identity", "malformed"])("rejects %s mismatches", async (kind) => {
  const row = event();
  if (kind === "property") row.attributes.property_id = randomUUID();
  if (kind === "kind") row.attributes.event = "reservation_request";
  if (kind === "identity") Object.assign(row.attributes, { id: randomUUID() });
  const data = kind === "malformed" ? {} : row;
  await expect(fixture({ data: [data] }).api.list(propertyId, 1)).rejects.toThrow(
    "alteration_feed_scope_mismatch",
  );
  await expect(fixture({ data }).api.read(propertyId, eventId)).rejects.toThrow(
    "alteration_feed_scope_mismatch",
  );
});
it("rejects another event UUID and invalid page parameters", async () => {
  await expect(
    fixture({ data: { ...event(), id: randomUUID() } }).api.read(propertyId, eventId),
  ).rejects.toThrow("alteration_feed_scope_mismatch");
  const { api, request } = fixture({ data: [] });
  await expect(api.list(propertyId, 0)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("sanitizes upstream errors and propagates shutdown through an abort signal", async () => {
  const { api, request } = fixture({ data: [] });
  const controller = new AbortController();
  controller.abort();
  request.mockRejectedValueOnce(new Error("private upstream details"));
  await expect(api.list(propertyId, 1, controller.signal)).rejects.toThrow(
    "alteration_feed_unavailable",
  );
  expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
});
it("rejects non-provider origins before any credentialed request", () => {
  expect(() =>
    createChannexAlterationFeed({ apiBaseUrl: "https://example.com", apiKey: "secret" }),
  ).toThrow("invalid_channex_configuration");
});
