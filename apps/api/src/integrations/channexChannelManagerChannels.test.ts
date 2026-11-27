import { describe, expect, it, vi } from "vitest";

import {
  createChannexChannelManagerChannelReader,
  markup,
} from "./channexChannelManagerChannels.js";

const PROPERTY = "26062000-0000-4000-8000-000000000001";
const OTHER_HOTEL = "26062000-0000-4000-8000-000000000002";
const OWN_RATE_A = "26062000-0000-4000-8000-0000000000a1";
const OWN_RATE_B = "26062000-0000-4000-8000-0000000000a2";
const OTHER_RATE = "26062000-0000-4000-8000-0000000000b1";

const ratePlans = [
  { id: OWN_RATE_A, attributes: { property_id: PROPERTY } },
  { id: OWN_RATE_B, relationships: { property: { data: { id: PROPERTY } } } },
];

const bookingCom = {
  id: "channel-booking",
  attributes: {
    channel: "BookingCom",
    title: "Booking.com",
    is_active: true,
    currency: "EUR",
    properties: [PROPERTY],
    settings: {
      hotel_id: 4417201,
      machine_account: "secret-machine-account",
      derived_option: { rate: [["increase_by_percent", "12"]] },
    },
    rate_plans: [
      { rate_plan_id: OWN_RATE_A, settings: { room_type_code: "441720101", rate_plan_code: "1" } },
      { rate_plan_id: OWN_RATE_B, settings: { room_type_code: "441720102", rate_plan_code: "1" } },
    ],
  },
};

// One Airbnb account for two hotels: only this hotel's listings count.
const airbnb = {
  id: "channel-airbnb",
  attributes: {
    channel: "AirBNB",
    is_active: true,
    currency: "EUR",
    properties: [PROPERTY, OTHER_HOTEL],
    settings: { booking_amount_settings: { password: "secret-payout" } },
    rate_plans: [
      {
        rate_plan_id: OWN_RATE_A,
        settings: { listing_id: "111", derived_option: { rate: [["increase_by_percent", "10"]] } },
      },
      {
        rate_plan_id: OWN_RATE_B,
        settings: { listing_id: "222", derived_option: { rate: [["increase_by_percent", "10"]] } },
      },
      {
        rate_plan_id: OTHER_RATE,
        settings: { listing_id: "999", derived_option: { rate: [["increase_by_percent", "25"]] } },
      },
    ],
  },
};

const openChannel = {
  id: "channel-open",
  attributes: { channel: "OpenChannel", is_active: true, properties: [PROPERTY], rate_plans: [] },
};

function channex(channels: unknown[], plans: unknown[] = ratePlans) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const data = url.pathname === "/api/v1/channels" ? channels : plans;
    return Response.json({ data, meta: { page: 1, limit: 100, total: data.length } });
  });
}

describe("Channex channels for the Channel manager page (VAY-2606)", () => {
  it("shows Booking.com and Airbnb with this hotel's rooms, listings and markups only", async () => {
    const fetch = channex([openChannel, airbnb, bookingCom]);
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch,
    });

    const result = await read({ externalPropertyId: PROPERTY });

    expect(result).toEqual({
      status: "ok",
      items: [
        {
          ota: "booking_com",
          active: true,
          otaPropertyId: "4417201",
          mappedCount: 2,
          markup: {
            kind: "rules",
            rules: [{ operation: "increase_by_percent", value: "12" }],
            currency: "EUR",
          },
        },
        {
          ota: "airbnb",
          active: true,
          otaPropertyId: null,
          mappedCount: 2,
          markup: {
            kind: "rules",
            rules: [{ operation: "increase_by_percent", value: "10" }],
            currency: "EUR",
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/secret/);
  });

  it("only reads, scoped to the hotel, and asks Channex again only after a minute", async () => {
    const fetch = channex([bookingCom]);
    let now = 1_000_000;
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch,
      now: () => now,
    });

    await read({ externalPropertyId: PROPERTY });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetch.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://app.channex.io");
      expect(url.searchParams.get("filter[property_id]")).toBe(PROPERTY);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { "user-api-key": "key" },
      });
      expect(init?.body).toBeUndefined();
    }
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname).sort()).toEqual([
      "/api/v1/channels",
      "/api/v1/rate_plans",
    ]);

    now += 59_000;
    await read({ externalPropertyId: PROPERTY });
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 2_000;
    await read({ externalPropertyId: PROPERTY });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("reads every page Channex reports", async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      id: `26062000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      attributes: { property_id: PROPERTY },
    }));
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/channels")
        return Response.json({ data: [bookingCom], meta: { total: 1 } });
      const page = Number(url.searchParams.get("pagination[page]"));
      return Response.json({
        data: many.slice((page - 1) * 100, page * 100),
        meta: { total: many.length },
      });
    });
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch: request,
    });
    await read({ externalPropertyId: PROPERTY });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("leaves out another hotel's channel or rate plan, never showing them", async () => {
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch: channex(
        [
          bookingCom,
          {
            ...bookingCom,
            id: "channel-other",
            attributes: { ...bookingCom.attributes, properties: [OTHER_HOTEL] },
          },
        ],
        [...ratePlans, { id: OTHER_RATE, attributes: { property_id: OTHER_HOTEL } }],
      ),
    });
    expect(await read({ externalPropertyId: PROPERTY })).toMatchObject({
      items: [{ ota: "booking_com", mappedCount: 2 }],
    });
  });

  it.each([
    [
      "a channel without its hotels",
      channex([{ ...bookingCom, attributes: { ...bookingCom.attributes, properties: undefined } }]),
    ],
    ["a rate plan without its hotel", channex([bookingCom], [{ id: OTHER_RATE, attributes: {} }])],
    ["an error answer", vi.fn<typeof fetch>(async () => new Response("no", { status: 401 }))],
  ])("refuses %s, so the page says it couldn't read Channex", async (_label, fetch) => {
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch,
    });
    await expect(read({ externalPropertyId: PROPERTY })).rejects.toThrow();
  });

  it("keeps a failed read for 30 seconds and shares a read in flight", async () => {
    let now = 1_000_000;
    let failing = true;
    const ok = channex([bookingCom]);
    const fetch = vi.fn<typeof globalThis.fetch>(async (...args) =>
      failing ? new Response("busy", { status: 429 }) : ok(...args),
    );
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch,
      now: () => now,
    });

    await expect(read({ externalPropertyId: PROPERTY })).rejects.toThrow("channex_http_429");
    const calls = fetch.mock.calls.length;
    now += 29_000;
    await expect(read({ externalPropertyId: PROPERTY })).rejects.toThrow("channex_http_429");
    expect(fetch).toHaveBeenCalledTimes(calls);

    failing = false;
    now += 2_000;
    const [first, second] = await Promise.all([
      read({ externalPropertyId: PROPERTY }),
      read({ externalPropertyId: PROPERTY }),
    ]);
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(calls + 2);
  });

  it("shows a channel that maps none of this hotel's rooms as not selling", async () => {
    const shared = {
      ...airbnb,
      attributes: { ...airbnb.attributes, rate_plans: [airbnb.attributes.rate_plans[2]] },
    };
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch: channex([shared]),
    });
    expect(await read({ externalPropertyId: PROPERTY })).toMatchObject({
      items: [{ ota: "airbnb", active: false, mappedCount: 0 }],
    });
  });

  it("never asks Channex for a malformed property id", async () => {
    const fetch = channex([]);
    const read = createChannexChannelManagerChannelReader({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "key",
      fetch,
    });
    await expect(read({ externalPropertyId: "../properties" })).rejects.toThrow(
      "channex_property_id_invalid",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a channel's markup as Channex applies it", () => {
  const rule = (operation: string, value: string) => [operation, value];

  it("takes the channel's own rules for mappings without their own", () => {
    expect(
      markup({ derived_option: { rate: [rule("increase_by_percent", "15")] } }, [{}, {}], "EUR"),
    ).toEqual({
      kind: "rules",
      rules: [{ operation: "increase_by_percent", value: "15" }],
      currency: "EUR",
    });
  });

  it("lets a mapping's rules replace the channel's, and says when mappings differ", () => {
    const channel = { derived_option: { rate: [rule("increase_by_percent", "15")] } };
    expect(
      markup(channel, [{ derived_option: { rate: [rule("increase_by_percent", "5")] } }], null),
    ).toMatchObject({
      rules: [{ operation: "increase_by_percent", value: "5" }],
    });
    expect(
      markup(channel, [{}, { derived_option: { rate: [rule("increase_by_percent", "5")] } }], null),
    ).toEqual({
      kind: "varies",
    });
    // An empty rule list on a mapping could hide the channel's markup: unknown, never "None".
    expect(markup(channel, [{ derived_option: { rate: [] } }], null)).toEqual({ kind: "unknown" });
    expect(markup(channel, [{ derived_option: { rate: null } }], null)).toEqual({
      kind: "unknown",
    });
    expect(markup({}, [{ derived_option: { rate: [] } }], "EUR")).toEqual({
      kind: "rules",
      rules: [],
      currency: "EUR",
    });
    // An explicit zero rule is how Channex exempts a mapping.
    expect(
      markup(channel, [{ derived_option: { rate: [rule("increase_by_percent", "0")] } }], null),
    ).toMatchObject({ rules: [] });
    // "5" and "5.00" are the same rule.
    expect(
      markup(
        { derived_option: { rate: [rule("increase_by_percent", "5.00")] } },
        [{}, { derived_option: { rate: [rule("increase_by_percent", "5")] } }],
        null,
      ),
    ).toMatchObject({ kind: "rules", rules: [{ operation: "increase_by_percent", value: "5" }] });
    // A mapping's stop-sell rule alone doesn't replace the channel's price rules.
    expect(
      markup(channel, [{ derived_option: { stop_sell: [["set", true]] } }], null),
    ).toMatchObject({
      rules: [{ operation: "increase_by_percent", value: "15" }],
    });
  });

  it("treats no rules and zero rules as no markup, and keeps amounts and their order", () => {
    expect(markup({}, [], "EUR")).toEqual({ kind: "rules", rules: [], currency: "EUR" });
    expect(
      markup({ derived_option: { rate: [rule("increase_by_percent", "0")] } }, [], null),
    ).toMatchObject({
      rules: [],
    });
    expect(
      markup(
        {
          derived_option: {
            rate: [rule("increase_by_percent", "5.00"), rule("increase_by_amount", "12.00")],
          },
        },
        [],
        "EUR",
      ),
    ).toEqual({
      kind: "rules",
      rules: [
        { operation: "increase_by_percent", value: "5" },
        { operation: "increase_by_amount", value: "12" },
      ],
      currency: "EUR",
    });
  });

  it.each([
    [[rule("multiply_by", "2")]],
    [[rule("increase_by_percent", "12%")]],
    [[["increase_by_percent"]]],
    ["12"],
  ])("never guesses a rule it can't read (%j)", (rate) => {
    expect(markup({ derived_option: { rate } }, [], null)).toEqual({ kind: "unknown" });
  });
});
