import { describe, expect, it, vi } from "vitest";
import { createChannexReviewReplies } from "./channexReviewReplies.js";

const identity = { reviewId: "review-1", externalPropertyId: "property-1" };
const data = {
  id: identity.reviewId,
  relationships: { property: { data: { id: identity.externalPropertyId } } },
  attributes: { ota: "BookingCom", content: "Great", is_hidden: false, is_replied: false },
};
function setup(response: unknown, status = 200) {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(response), { status }));
  return {
    request,
    provider: createChannexReviewReplies({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "test",
      fetch: request,
    }),
  };
}
describe("Channex reply contract", () => {
  it("validates identity and sends the documented payload", async () => {
    const { request, provider } = setup({
      data: { ...data, attributes: { ...data.attributes, is_replied: true, reply: "Thanks" } },
    });
    expect(await provider.send(identity, "Thanks")).toEqual({
      state: "accepted",
      replyBody: "Thanks",
    });
    expect(request.mock.calls[0][0].toString()).toBe(
      "https://staging.channex.io/api/v1/reviews/review-1/reply",
    );
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({
      reply: { reply: "Thanks" },
    });
  });
  it.each([
    [{ ...data.attributes }, "ready"],
    [{ ...data.attributes, ota: "Other" }, "unavailable"],
    [{ ...data.attributes, content: "" }, "unavailable"],
    [{ ...data.attributes, is_hidden: true }, "unavailable"],
    [{ ...data.attributes, is_replied: true }, "accepted"],
  ])("checks current channel eligibility", async (attributes, state) => {
    expect((await setup({ data: { ...data, attributes } }).provider.check(identity)).state).toBe(
      state,
    );
  });
  it.each([401, 403, 404, 422, 429, 500, 502])(
    "classifies HTTP %s without a retry",
    async (status) => {
      const { provider, request } = setup({}, status);
      expect((await provider.send(identity, "Thanks")).state).toBe(
        status >= 500 ? "uncertain" : "failed",
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("treats wrong identity, missing confirmation and timeouts as uncertain", async () => {
    for (const response of [{ data: { ...data, id: "other" } }, { data }, { success: true }])
      expect((await setup(response).provider.send(identity, "Thanks")).state).toBe("uncertain");
    const { provider, request } = setup({});
    request.mockRejectedValue(new Error("timeout"));
    expect((await provider.send(identity, "Thanks")).state).toBe("uncertain");
  });
});
