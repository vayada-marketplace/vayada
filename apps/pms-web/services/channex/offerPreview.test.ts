import { afterEach, expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { pmsOperationsClient } from "@/services/api/pmsOperationsClient";
import { readOfferPreview, requestOfferProvisioning } from "./offerPreview";
vi.mock("@/services/api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: vi.fn(), post: vi.fn() },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));
afterEach(() => vi.resetAllMocks());
const id = "61000000-0000-4000-8000-000000000001";
const room = {
  propertyId: id,
  roomTypeId: id,
  revision: 1,
  currency: "EUR",
  capacity: { adults: 1, children: 0 },
  offers: [
    { id: "flex", meal: { kind: "room_only" } },
    { id: "other", meal: { kind: "room_only" } },
  ],
} as unknown as PricingConfiguration;
const response = {
  schemaVersion: 1,
  propertyId: id,
  roomTypeId: id,
  offerId: "flex",
  publicationRevision: 1,
  primaryOccupancy: 1,
  canSend: false,
  canProvision: false,
  kind: "preview",
  configuration: {
    currency: "EUR",
    meal_type: "room_only",
    options: [{ occupancy: 1, is_primary: true }],
  },
};
it("validates scope, read-only flags and bounded occupancy before showing server data", async () => {
  for (const patch of [
    { propertyId: "other" },
    { primaryOccupancy: 2 },
    { publicationRevision: 2 },
    { canSend: true },
    { canProvision: true },
    { configuration: { ...response.configuration, options: [{ occupancy: 2, is_primary: true }] } },
  ]) {
    vi.mocked(pmsOperationsClient.get).mockResolvedValue({ ...response, ...patch });
    await expect(readOfferPreview(id, room, "flex", 1)).rejects.toThrow();
  }
  vi.mocked(pmsOperationsClient.get).mockResolvedValue({
    ...response,
    kind: "unsupported",
    reason: "child_representation_unavailable",
  });
  expect(await readOfferPreview(id, room, "flex", 1)).toEqual({
    kind: "unsupported",
    reason: "child_representation_unavailable",
  });
});

it("submits only the explicit selected offer without provider identities", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("command").mockReturnValueOnce("key") });
  vi.mocked(pmsOperationsClient.post).mockResolvedValue({ operationId: "operation" });
  await expect(requestOfferProvisioning(id, room, "flex", 1)).resolves.toEqual({
    operationId: "operation",
  });
  expect(vi.mocked(pmsOperationsClient.post)).toHaveBeenCalledWith(
    expect.stringContaining(`/properties/${id}/channex/published-offers/provision`),
    {
      commandId: "command",
      idempotencyKey: "key",
      roomTypeId: id,
      offerId: "flex",
      publicationRevision: 1,
      primaryOccupancy: 1,
    },
    expect.anything(),
  );
});
