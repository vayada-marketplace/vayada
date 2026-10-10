import { describe, expect, it } from "vitest";

import {
  createStripeLegacySubscriptionAdoption,
  inspectLegacySubscription,
} from "./stripeLegacySubscriptionAdoption.js";

describe("Stripe legacy subscription adoption port", () => {
  it("inspects a legacy subscription without writing", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const port = createStripeLegacySubscriptionAdoption({
      secretKey: "sk_test_secret",
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: String(init?.method) });
        return response(legacySubscription());
      },
    });

    await expect(port.inspectLegacySubscription("sub_legacy")).resolves.toMatchObject({
      hotelId: "property-1",
      paymentKind: "fixed_plan",
      flatThirtyDayPrice: true,
      unitAmountMinor: 3_500,
      productId: "prod_legacy",
      adoptionMarker: null,
      snapshot: { fixedPlanVerified: false, retainedLegacyPrice: false, currency: "EUR" },
    });
    expect(calls).toEqual([
      { url: "https://api.stripe.com/v1/subscriptions/sub_legacy", method: "GET" },
    ]);
  });

  it("marks adoption with metadata only, pinning the kept product", async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const port = createStripeLegacySubscriptionAdoption({
      secretKey: "sk_test_secret",
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body: String(init?.body ?? ""),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return response(legacySubscription());
      },
    });

    await expect(
      port.markAdopted({
        subscriptionId: "sub_legacy",
        propertyId: "property-1",
        organizationId: "organization-1",
        productId: "prod_legacy",
        idempotencyKey: "legacy-adoption:property-1:sub_legacy:v1",
      }),
    ).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/subscriptions/sub_legacy");
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("legacy-adoption:property-1:sub_legacy:v1");
    const body = new URLSearchParams(calls[0]?.body);
    expect([...body.keys()].sort()).toEqual([
      "metadata[vayada_legacy_adoption]",
      "metadata[vayada_legacy_product]",
      "metadata[vayada_organization_id]",
      "metadata[vayada_plan]",
      "metadata[vayada_property_id]",
    ]);
    expect(body.get("metadata[vayada_legacy_adoption]")).toBe("v1");
    expect(body.get("metadata[vayada_legacy_product]")).toBe("prod_legacy");
  });

  it("verifies the marked subscription as the retained legacy shape on a re-read", async () => {
    const marked = {
      ...legacySubscription(),
      metadata: {
        ...legacySubscription().metadata,
        vayada_property_id: "property-1",
        vayada_organization_id: "organization-1",
        vayada_plan: "fixed",
        vayada_legacy_adoption: "v1",
        vayada_legacy_product: "prod_legacy",
      },
    };
    expect(inspectLegacySubscription(marked).snapshot).toMatchObject({
      fixedPlanVerified: true,
      retainedLegacyPrice: true,
      amountMinor: 3_500,
      propertyId: "property-1",
      organizationId: "organization-1",
    });
  });

  it("searches legacy subscriptions by hotel through every page", async () => {
    const urls: string[] = [];
    const port = createStripeLegacySubscriptionAdoption({
      secretKey: "sk_test_secret",
      fetch: async (input) => {
        urls.push(String(input));
        return urls.length === 1
          ? response({
              data: [{ id: "sub_a", status: "active" }],
              has_more: true,
              next_page: "page_2",
            })
          : response({ data: [{ id: "sub_b", status: "canceled" }], has_more: false });
      },
    });

    await expect(port.findLegacySubscriptionsForHotel("property-1")).resolves.toEqual([
      { subscriptionId: "sub_a", status: "active" },
      { subscriptionId: "sub_b", status: "canceled" },
    ]);
    const first = new URL(urls[0]!);
    expect(first.pathname).toBe("/v1/subscriptions/search");
    expect(first.searchParams.get("query")).toBe(
      "metadata['hotel_id']:'property-1' AND metadata['vayada_payment_kind']:'fixed_plan'",
    );
    expect(new URL(urls[1]!).searchParams.get("page")).toBe("page_2");
  });

  it("lists every legacy fixed-plan subscription through every page, read-only", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const port = createStripeLegacySubscriptionAdoption({
      secretKey: "sk_test_secret",
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: String(init?.method) });
        return calls.length === 1
          ? response({ data: [legacySubscription()], has_more: true, next_page: "page_2" })
          : response({
              data: [{ ...legacySubscription(), id: "sub_two", status: "unpaid" }],
              has_more: false,
            });
      },
    });

    const found = await port.searchLegacyFixedPlanSubscriptions();

    expect(found.map((item) => [item.snapshot.subscriptionId, item.snapshot.status])).toEqual([
      ["sub_legacy", "active"],
      ["sub_two", "unpaid"],
    ]);
    expect(found[0]).toMatchObject({ hotelId: "property-1", flatThirtyDayPrice: true });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/v1/subscriptions/search");
    expect(first.searchParams.get("query")).toBe("metadata['vayada_payment_kind']:'fixed_plan'");
    expect(new URL(calls[1]!.url).searchParams.get("page")).toBe("page_2");
  });

  it("does not treat a tiered, multi-item or quantity>1 subscription as a flat legacy price", () => {
    const base = legacySubscription();
    const item = base.items.data[0]!;
    expect(
      inspectLegacySubscription({
        ...base,
        items: { data: [{ ...item, price: { ...item.price, billing_scheme: "tiered" } }] },
      }).flatThirtyDayPrice,
    ).toBe(false);
    expect(
      inspectLegacySubscription({ ...base, items: { data: [{ ...item, quantity: 2 }] } })
        .flatThirtyDayPrice,
    ).toBe(false);
    for (const price of [
      { currency: "usd" },
      { recurring: { interval: "day", interval_count: 30, usage_type: "metered" } },
    ]) {
      expect(
        inspectLegacySubscription({
          ...base,
          items: { data: [{ ...item, price: { ...item.price, ...price } }] },
        }).flatThirtyDayPrice,
      ).toBe(false);
    }
    expect(
      inspectLegacySubscription({ ...base, items: { data: [item, { ...item, id: "si_2" }] } })
        .unitAmountMinor,
    ).toBeNull();
  });

  it("surfaces Stripe errors instead of a snapshot", async () => {
    const port = createStripeLegacySubscriptionAdoption({
      secretKey: "sk_test_secret",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "No such subscription" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(port.inspectLegacySubscription("sub_missing")).rejects.toThrow(
      "No such subscription",
    );
  });
});

function legacySubscription() {
  return {
    id: "sub_legacy",
    customer: "cus_legacy",
    status: "active",
    cancel_at_period_end: false,
    metadata: { hotel_id: "property-1", vayada_payment_kind: "fixed_plan" },
    items: {
      data: [
        {
          id: "si_legacy",
          quantity: 1,
          current_period_start: 1_786_449_600,
          current_period_end: 1_789_041_600,
          price: {
            id: "price_legacy_inline",
            currency: "eur",
            billing_scheme: "per_unit",
            unit_amount: 3_500,
            product: "prod_legacy",
            recurring: { interval: "day", interval_count: 30, usage_type: "licensed" },
            metadata: {},
          },
        },
      ],
    },
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
