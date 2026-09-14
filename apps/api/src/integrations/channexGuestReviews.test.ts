import { describe, expect, it, vi } from "vitest";
import { createChannexGuestReviews, parseGuestReviewDraft } from "./channexGuestReviews.js";
const identity = { reviewId: "review-1", externalPropertyId: "property-1" };
const draft = {
  respectHouseRules: 5,
  communication: 4,
  cleanliness: 3,
  publicReview: "Good guest",
  privateReview: "Thank you",
  recommended: true,
};
const attributes = {
  ota: "Airbnb",
  guest_name: "Ada Guest",
  ota_reservation_id: "HM123",
  is_hidden: true,
  is_expired: false,
  is_replied: false,
};
const data = {
  id: identity.reviewId,
  attributes,
  relationships: { property: { data: { id: identity.externalPropertyId } } },
};
function setup(payload: unknown, status = 200) {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(payload), { status }));
  return {
    request,
    provider: createChannexGuestReviews({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "test",
      fetch: request,
    }),
  };
}
describe("Channex guest-review contract", () => {
  it("sends the supported fields and recognizes documented acceptance", async () => {
    const { provider, request } = setup({ success: true });
    expect(await provider.send(identity, draft)).toEqual({ state: "accepted" });
    expect(request.mock.calls[0][0].toString()).toContain("/reviews/review-1/guest_review");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({
      review: {
        scores: [
          { category: "respect_house_rules", rating: 5 },
          { category: "communication", rating: 4 },
          { category: "cleanliness", rating: 3 },
        ],
        public_review: "Good guest",
        private_review: "Thank you",
        is_reviewee_recommended: true,
      },
    });
  });
  it.each([
    [{}, "ready"],
    [{ is_expired: true }, "unavailable"],
    [{ is_expired: undefined }, "unavailable"],
    [{ is_hidden: false }, "unavailable"],
    [{ is_hidden: undefined }, "unavailable"],
    [{ ota: "BookingCom" }, "unavailable"],
    [{ guest_name: "" }, "unavailable"],
    [{ ota_reservation_id: "" }, "unavailable"],
    [{ is_replied: true, reply: { reply: "Public reply" } }, "ready"],
    [{ reply: { guest_review: { public_review: "Good guest" } } }, "accepted"],
    [{ reply: { guest_review: true } }, "ready"],
    [{ reply: { guest_review: "accepted" } }, "ready"],
    [{ reply: { guest_review: [] } }, "ready"],
  ])("requires explicit current eligibility %j", async (override, state) => {
    expect(
      (
        await setup({
          data: { ...data, attributes: { ...attributes, ...override } },
        }).provider.check(identity)
      ).state,
    ).toBe(state);
  });
  it("filters mismatched properties and discovers hidden records without guest content", async () => {
    const { provider, request } = setup({
      data: [data, { ...data, id: "wrong", relationships: {} }],
      meta: { total: 51 },
    });
    expect(await provider.list(identity.externalPropertyId, 1)).toMatchObject({
      more: true,
      items: [{ reviewId: "review-1", state: "ready" }],
    });
    expect(
      new URL(request.mock.calls[0][0].toString()).searchParams.get("filter[property_id]"),
    ).toBe("property-1");
    expect(
      (await setup({ data }).provider.check({ ...identity, externalPropertyId: "other" })).state,
    ).toBe("unavailable");
  });
  it.each([400, 401, 403, 404, 422, 429, 500, 502])("classifies rejection %s", async (status) => {
    const { provider, request } = setup({}, status);
    expect((await provider.send(identity, draft)).state).toBe(
      status >= 500 ? "uncertain" : "failed",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("keeps missing confirmation and timeouts uncertain", async () => {
    expect((await setup({}).provider.send(identity, draft)).state).toBe("uncertain");
    const { provider, request } = setup({});
    request.mockRejectedValue(new Error("timeout"));
    expect((await provider.send(identity, draft)).state).toBe("uncertain");
  });
  it.each([
    { communication: 0 },
    { cleanliness: 6 },
    { respectHouseRules: 2.5 },
    { publicReview: " " },
    { privateReview: "\u0000" },
    { publicReview: "x".repeat(10001) },
    { recommended: "true" },
  ])("rejects invalid draft", (invalid) => {
    expect(parseGuestReviewDraft({ ...draft, ...invalid })).toBeUndefined();
  });
  it("normalizes a valid draft without copying unknown fields", () => {
    expect(
      parseGuestReviewDraft({ ...draft, publicReview: " Good guest ", tags: ["unknown"] }),
    ).toEqual(draft);
  });
});
