import { z } from "zod";

const item = z.object({
  id: z.uuid(),
  attributes: z.object({
    id: z.uuid().optional(),
    property_id: z.uuid(),
    event: z.literal("alteration_request"),
    payload: z.object({ resolved: z.boolean() }),
  }),
});
/** GET-only discovery. Intake separately validates proposal fields before storage. */
export function createChannexAlterationFeed(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}) {
  if (
    !/^https:\/\/(app|staging)\.channex\.io(?:\/|\/api\/v1\/?)?$/.test(config.apiBaseUrl) ||
    !config.apiKey.trim()
  )
    throw new Error("invalid_channex_configuration");
  async function get(path: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await (config.fetch ?? fetch)(new URL(path, config.apiBaseUrl), {
        headers: { "user-api-key": config.apiKey },
        method: "GET",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error("alteration_feed_unavailable");
    }
  }
  function validate(value: unknown, propertyId: string) {
    const parsed = item.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.attributes.property_id !== propertyId ||
      (parsed.data.attributes.id && parsed.data.attributes.id !== parsed.data.id)
    )
      throw new Error("alteration_feed_scope_mismatch");
    return parsed.data;
  }
  return {
    async list(propertyId: string, page: number, signal?: AbortSignal) {
      z.uuid().parse(propertyId);
      z.number().int().min(1).max(10_000).parse(page);
      const query = new URLSearchParams({
        "filter[property_id]": propertyId,
        "filter[event]": "alteration_request",
        "pagination[page]": String(page),
        "pagination[limit]": "20",
        "order[inserted_at]": "desc",
      });
      const response = z
        .object({ data: z.array(z.unknown()).max(20) })
        .safeParse(await get(`/api/v1/live_feed?${query}`, signal));
      if (!response.success) throw new Error("alteration_feed_invalid_page");
      const events = response.data.data.map((value) => validate(value, propertyId));
      return {
        eventIds: events
          .filter((event) => !event.attributes.payload.resolved)
          .map((event) => event.id),
        hasMore: events.length === 20,
      };
    },
    async read(propertyId: string, eventId: string, signal?: AbortSignal) {
      z.uuid().parse(propertyId);
      z.uuid().parse(eventId);
      const response = z
        .object({ data: z.unknown() })
        .parse(await get(`/api/v1/live_feed/${eventId}`, signal));
      const event = validate(response.data, propertyId);
      if (event.id !== eventId) throw new Error("alteration_feed_scope_mismatch");
      return event.attributes.payload.resolved ? null : response;
    },
  };
}
