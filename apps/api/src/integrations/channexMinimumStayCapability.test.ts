import { describe, expect, it, vi } from "vitest";
import { verifyChannexMinimumStayCapability as verify } from "./channexMinimumStayCapability.js";
const id = "8f4c1e47-3de1-4150-8bde-ad031a013842";
const response = () => ({
  data: { type: "property", id, attributes: { id, settings: { min_stay_type: "both" } } },
});
describe("Channex explicit minimum-stay capability", () => {
  it("requires the scoped property to support both explicit fields", async () => {
    const get = vi.fn(async () => response());
    expect(await verify(id, get)).toEqual({ externalPropertyId: id, minimumStayMode: "both" });
    expect(get).toHaveBeenCalledExactlyOnceWith("GET", `/api/v1/properties/${id}`);
  });
  it.each(["arrival", "through", "unknown", undefined, null, true])(
    "rejects unsupported or absent mode %s",
    async (mode) => {
      const body = response();
      Object.assign(body.data.attributes.settings, { min_stay_type: mode });
      await expect(verify(id, async () => body)).rejects.toThrow(
        "ari_restriction_capability_unavailable",
      );
    },
  );
  it.each([
    {},
    { data: null },
    { data: { ...response().data, id: "other" } },
    { data: { ...response().data, type: "room_type" } },
    {
      data: {
        ...response().data,
        attributes: { id: "other", settings: { min_stay_type: "both" } },
      },
    },
    { data: { ...response().data, attributes: { settings: null } } },
    { ...response(), errors: {} },
    { ...response(), warnings: [] },
    { ...response(), meta: null },
    { ...response(), meta: { warnings: ["partial"] } },
  ])("rejects ambiguous identity or envelope %j", async (body) => {
    await expect(verify(id, async () => body)).rejects.toThrow(
      "ari_restriction_capability_unavailable",
    );
  });
  it("rejects malformed scope before IO", async () => {
    const get = vi.fn();
    await expect(verify("../other", get)).rejects.toThrow("ari_restriction_capability_unavailable");
    expect(get).not.toHaveBeenCalled();
  });
  it("propagates transport failure without returning a capability", async () => {
    await expect(
      verify(id, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
});
