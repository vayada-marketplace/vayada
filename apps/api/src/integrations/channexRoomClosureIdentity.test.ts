import { describe, expect, it } from "vitest";
import { verifyChannexRoomClosureIdentity } from "./channexRoomClosureIdentity.js";

const scope = { propertyId: "property", roomId: "room", rateIds: ["rate"] };
const rate = {
  id: "rate",
  relationships: { room_type: { data: { id: "room" } }, property: { data: { id: "property" } } },
};
const channel = { id: "channel", attributes: { rate_plans: [{ rate_plan_id: "another-rate" }] } };
const reader =
  (rates: unknown[] = [rate], channels: unknown[] = [channel], total?: number) =>
  async (path: string) => {
    const data = path.includes("/rate_plans?") ? rates : channels;
    return { data, meta: { total: total ?? data.length } };
  };
describe("Channex closure provider identity", () => {
  it("accepts complete matching rates and unrelated channel bindings", async () => {
    await expect(verifyChannexRoomClosureIdentity(reader(), scope)).resolves.toBeUndefined();
  });
  it.each([
    { rate_plans: [{ rate_plan_id: "rate" }] },
    { rate_plans: [], settings: { mappingSettings: { rooms: { external: "room" } } } },
    { rate_plans: [], settings: { mapping: { room: "external" } } },
    {},
    { rate_plans: [{}] },
  ])("rejects OTA bindings and unknown channel shape %j", async (attributes) => {
    await expect(
      verifyChannexRoomClosureIdentity(reader([rate], [{ id: "channel", attributes }]), scope),
    ).rejects.toThrow("ota_binding_unsupported");
  });
  it.each([
    [],
    [rate, { ...rate, id: "extra" }],
    [
      {
        ...rate,
        relationships: { ...rate.relationships, room_type: { data: { id: "other-room" } } },
      },
    ],
  ])("rejects missing, extra, or mismatched provider rates %j", async (...rates) => {
    await expect(verifyChannexRoomClosureIdentity(reader(rates.flat()), scope)).rejects.toThrow(
      "provider_identity_mismatch",
    );
  });
  it("rejects partial pagination", async () => {
    await expect(
      verifyChannexRoomClosureIdentity(reader([rate], [channel], 101), scope),
    ).rejects.toThrow("identity_incomplete");
  });
  it.each([
    [rate, { id: "extra" }],
    [
      {
        ...rate,
        relationships: { ...rate.relationships, property: { data: { id: "other-property" } } },
      },
    ],
  ])("rejects unknown rate ownership %j", async (...rates) => {
    await expect(verifyChannexRoomClosureIdentity(reader(rates.flat()), scope)).rejects.toThrow(
      "identity_incomplete",
    );
  });
});
