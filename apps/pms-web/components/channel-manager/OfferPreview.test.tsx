import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { ApiErrorResponse } from "@/services/api/client";
import { pmsOperationsClient } from "@/services/api/pmsOperationsClient";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
import { OfferPreview } from "./OfferPreview";
vi.mock("@/services/api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: vi.fn(), post: vi.fn() },
  pmsOperationsRequestOptions: { cache: "no-store" },
}));
vi.mock("@/services/api/replacementPricingClient", () => ({
  createReplacementPricingClient: vi.fn(),
}));
vi.mock("@/services/rooms", () => ({
  pmsOperationsRoomsReadService: {
    listRoomTypes: async (propertyId: string) => ({
      propertyId,
      items: [{ roomTypeId: room.roomTypeId, name: "Double room" }],
    }),
  },
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", { href }, children),
}));
vi.mock("./ChannelManagerUi", () => ({ channelManagerButtonClass: "button" }));
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
const publication = { rooms: [room], revision: 1, stale: false };
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
let view: ReactTestRenderer;
afterEach(() => {
  if (view) act(() => view.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("React", React);
  const read = vi.fn().mockResolvedValue(publication);
  vi.mocked(createReplacementPricingClient).mockReturnValue({ read } as unknown as ReturnType<
    typeof createReplacementPricingClient
  >);
  vi.mocked(pmsOperationsClient.get).mockResolvedValue(response);
  vi.mocked(pmsOperationsClient.post).mockResolvedValue({ operationId: "operation" });
  await act(async () => {
    view = create(<OfferPreview propertyId={id} />);
  });
  return read;
}
async function choose(label: string, value: string) {
  await act(async () =>
    view.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
  );
}
async function select() {
  await choose("Preview room type", id);
  await choose("Published offer", "flex");
  await choose("Primary guest count", "1");
}
const button = () =>
  view.root.findAllByType("button").find((b) => b.children.includes("Preview configuration"))!;
it("requires explicit selection even for one guest and requests setup only after a verified preview", async () => {
  await setup();
  expect(view.root.findAllByType("select").every((s) => s.props.value === "")).toBe(true);
  expect(button().props.disabled).toBe(true);
  await select();
  expect(button().props.disabled).toBe(false);
  await act(async () => button().props.onClick());
  const text = JSON.stringify(view.toJSON());
  expect(text).toContain("EUR");
  expect(text).toContain("room only");
  expect(text).toContain("nothing has been sent");
  expect(vi.mocked(pmsOperationsClient.get).mock.calls[0][0]).toContain("primaryOccupancy=1");
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("request") });
  const setupButton = view.root
    .findAllByType("button")
    .find((b) => b.children.includes("Request Channex setup"))!;
  await act(async () => setupButton.props.onClick());
  expect(vi.mocked(pmsOperationsClient.post)).toHaveBeenCalledOnce();
  expect(JSON.stringify(view.toJSON())).toContain("Channex setup requested");
  await choose("Published offer", "other");
  expect(view.root.findByProps({ "aria-label": "Primary guest count" }).props.value).toBe("");
  expect(JSON.stringify(view.toJSON())).not.toContain("Currency:");
});
it("ignores delayed results after selection changes", async () => {
  await setup();
  await select();
  let finish!: (v: unknown) => void;
  vi.mocked(pmsOperationsClient.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => button().props.onClick());
  expect(button().props.disabled).toBe(true);
  await choose("Published offer", "other");
  await act(async () => finish(response));
  expect(JSON.stringify(view.toJSON())).not.toContain("Currency:");
});
it("requires refresh after stale pricing and clears old results on errors or new publication", async () => {
  const read = await setup();
  await select();
  await act(async () => button().props.onClick());
  vi.mocked(pmsOperationsClient.get).mockRejectedValueOnce(
    new ApiErrorResponse(409, { code: "refresh_required" }),
  );
  await act(async () => button().props.onClick());
  expect(JSON.stringify(view.toJSON())).not.toContain("Currency:");
  expect(view.root.findByProps({ "aria-label": "Preview room type" }).props.disabled).toBe(true);
  read.mockResolvedValue({ ...publication, revision: 2, rooms: [{ ...room, revision: 2 }] });
  await act(async () =>
    view.root
      .findAllByType("button")
      .find((b) => b.children.includes("Refresh and choose again"))!
      .props.onClick(),
  );
  expect(view.root.findAllByType("select").every((s) => s.props.value === "")).toBe(true);
  await select();
  vi.mocked(pmsOperationsClient.get).mockRejectedValueOnce(new Error("secret"));
  await act(async () => button().props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("could not be loaded");
  expect(JSON.stringify(view.toJSON())).not.toContain("secret");
});
it("handles missing, stale and denied published reads without exposing controls", async () => {
  const read = await setup();
  for (const value of [null, { ...publication, stale: true }]) {
    read.mockResolvedValue(value);
    await act(async () =>
      view.root
        .findAllByType("button")
        .find((b) => b.children.includes("Refresh published pricing"))!
        .props.onClick(),
    );
    expect(view.root.findAllByType("select")).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).toContain("Open pricing");
  }
  read.mockRejectedValue(new ApiErrorResponse(403, { code: "forbidden" }));
  await act(async () => view.root.findByType("button").props.onClick());
  expect(view.toJSON()).toBeNull();
});

it("discards a pending preview when switching to another property's publication", async () => {
  const read = await setup();
  await select();
  let finish!: (v: unknown) => void;
  vi.mocked(pmsOperationsClient.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => button().props.onClick());
  const nextId = "61000000-0000-4000-8000-000000000002";
  read.mockResolvedValue({
    ...publication,
    rooms: [{ ...room, propertyId: nextId, currency: "USD" }],
  });
  await act(async () => view.update(<OfferPreview propertyId={nextId} />));
  expect(createReplacementPricingClient).toHaveBeenLastCalledWith(nextId);
  expect(view.root.findAllByType("select")).toHaveLength(3);
  expect(view.root.findAllByType("select").every((s) => s.props.value === "")).toBe(true);
  await select();
  vi.mocked(pmsOperationsClient.get).mockResolvedValueOnce({
    ...response,
    propertyId: nextId,
    configuration: { ...response.configuration, currency: "USD" },
  });
  await act(async () => button().props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("USD");
  await act(async () => finish(response));
  expect(JSON.stringify(view.toJSON())).toContain("USD");
  expect(JSON.stringify(view.toJSON())).not.toContain("EUR");
  expect(vi.mocked(pmsOperationsClient.get).mock.calls[1][0]).toContain(`/properties/${nextId}/`);
});
it("discards a pending publication read after switching properties", async () => {
  const read = await setup();
  let finish!: (v: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() =>
    view.root
      .findAllByType("button")
      .find((b) => b.children.includes("Refresh published pricing"))!
      .props.onClick(),
  );
  const nextId = "61000000-0000-4000-8000-000000000002";
  read.mockResolvedValue(null);
  await act(async () => view.update(<OfferPreview propertyId={nextId} />));
  expect(JSON.stringify(view.toJSON())).toContain("Publish pricing first.");
  await act(async () => finish(publication));
  expect(JSON.stringify(view.toJSON())).toContain("Publish pricing first.");
  expect(view.root.findAllByType("select")).toHaveLength(0);
});
